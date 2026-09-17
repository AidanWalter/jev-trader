# jev-trader

One decision every Monad block. A TypeSafe Jev model watches the Kuru MON-USDC order book and answers buy or sell every ~300 ms. Every block posts a real post-only limit order on that side, one tick inside the touch, replacing the last one. Fills happen when a taker hits it, so the bot earns the spread instead of paying it. A small server streams every block to the dashboard.

## Run

    cp .env.example .env
    bun install
    bun run start

With no `PRIVATE_KEY` it dry-runs: real book, real decisions, simulated fills. Set `MODEL=jev` and `TYPESAFE_AI_API_KEY` to use Jev; the default `mock` is a momentum heuristic stand-in.

Plain-language explanation, including what it costs per hour and how to stop it: `GUIDE.md`. Running
it on a server close to the Jev API, which is what makes it decide on almost every block: `DEPLOY.md`.
The dashboard lives in `web/` (see `web/README.md`).

## Endpoints

Deployed (dry run): https://jev-trader-production.up.railway.app

- `GET /` snapshot: model, wallet, dryRun, latest block event
- `GET /history` last 1000 block events
- `GET /events` SSE: `snapshot` on connect, then one `block` event per block, plus a `fill` event whenever a live order's receipt lands

Every event (see `src/trader.ts` for types):

    {
      "block": 105488269, "ts": 1789593630676,
      "mid": 0.022636, "bestBid": 0.022628, "bestAsk": 0.022644, "spreadBps": 7.07,
      "decision": { "action": "buy", "probabilities": { "buy": 0.77, "sell": 0.23, "hold": 0 }, "upIn10": 0.77, "latencyMs": 81, "late": false },
      "quote": { "side": "buy", "price": 0.022629, "size": 200, "txHash": "0x…", "gasMon": 0.0357, "cancel": [100295801], "status": "sent", "orderId": null, "capped": false },
      "fill": null,
      "resting": { "bidMon": 200, "askMon": 200 },
      "position": { "side": "short", "size": 200, "entryPrice": 0.022633, "unrealizedUsd": -0.0006, "unrealizedMon": -0.027 },
      "totals": { "blocks": 3, "decisions": 3, "quotes": 3, "fills": 1, "reverted": 0, "lateBlocks": 0, "jevUsd": 0.000004, "gasMon": 0.107, "gasUsd": 0.0024, "realizedUsd": 0, "pnlUsd": -0.003, "pnlMon": -0.13, "pnlPct": -0.003 }
    }

Every block the model is asked about the move over `HORIZON_BLOCKS` (default 100, ~30 s) and answers `buy` or `sell`. `quote` is the order that block put on the book: a post-only limit order of `TRADE_SIZE_MON` on that side, `QUOTE_INSIDE_TICKS` inside the touch (clamped to the touch when the spread is too tight), in one `batchUpdate` that also cancels everything we had resting (`cancel`). `hold` appears only with `decision.late: true`, when the model missed the block and nothing was posted. When the position cap (or, live, margin funds) blocks a side, the quote goes on the other side with `capped: true` and `probabilities` still show the model's call. `resting` is our size known to be on the book after this block. `upIn10` equals the buy probability.

Live sends are fired and forgotten, so the `block` event carries the **intent**: `status: "sent"`, `gasMon` is `gasLimit x (last known base fee + priority)`. Monad charges the gas limit, so that is the real cost whether the order lands or not. The receipt arrives a block or two later as its own SSE event:

    event: quote
    data: { "block": 105488269, "quote": { …, "status": "placed", "orderId": 100295812, "gasMon": 0.0357 } }

`status` becomes `placed` (with the order id) or `reverted` (the book moved through the price before the tx landed, or a cancelled order had already filled). No receipt after 10 blocks gives `lost`. Fills are not in our own transactions: someone else's taker order hits our resting one, and the Trade log for it arrives via the same `eth_getLogs` poll that feeds the model. Each block with fills gets its own SSE event, and `position`, `realizedUsd` and `fills` update then:

    event: fill
    data: { "block": 105488271, "fill": { "side": "buy", "size": 200, "price": 0.022629, "txHash": "0x…", "orderId": 100295812, "simulated": false } }

`txHash` is the taker's transaction. In a dry run the quote is `status: "sim"`: the order rests for one block and a real print crossing its price fills it (`simulated: true`).

## Layout

    src/config.ts   env
    src/chain.ts    block feed (WebSocket newHeads + polling backstop, newest block only), raw RPC
    src/book.ts     one-eth_call order book reader (decodes getL2Book, merges the AMM vault)
    src/market.ts   Kuru: read book, hand-encoded batchUpdate (cancel + post-only place), margin deposits, local nonce, async confirmation
    src/model.ts    Model interface, JevModel (AI SDK experimental_evaluate), MockModel
    src/trader.ts   the loop: one in flight, hold when late, position and P&L accounting
    src/server.ts   Bun.serve: snapshot, history, SSE

    data/events.jsonl       every block event, appended as it happens (used by score-decisions.ts)
    data/open-orders.json   ids of our live orders, so a restart can cancel what we left behind
    scripts/*.ts            probes and measurements, see the sections below

## The 300 ms budget

A decision and an order have to fit in one block, so the hot loop makes exactly two RPC round trips:
one `eth_call` for the book (~18 ms on the public RPC, `READ_RPC_URL`) and one `eth_sendRawTransaction`
(`RPC_URL`), which returns as soon as the tx is accepted. Nothing else is on the path — no
`eth_estimateGas` (Monad charges gas on the limit, so the limit is hardcoded or derived once at
startup), no `eth_sendRawTransactionSync` (it blocks until the tx is Proposed), no gas price lookup
(static type-2 fees: `MAX_FEE_GWEI` cap, 2 gwei priority; the effective price is base + priority).
Receipts, the fee estimate and the vault check run off the hot path on later blocks. Measured in a
dry run with the mock model: read p50 18 ms, whole loop p50 100 ms (80 ms of it the mock's inference stand-in).

    bun run scripts/bench-read.ts     # book reader vs the SDK: exactness and latency
    bun run scripts/dry-encode.ts     # signs a buy and a sell offline, asserts the calldata matches the SDK

## Where the loop time actually goes

The budget above is a claim about the code. The clock, however, is mostly spent in the network, and
the numbers below come from a real Jev connection rather than a mock: same code, two places to run it.

| | home connection | Railway, US East |
| --- | --- | --- |
| book read, median | 35 ms | 17 ms |
| Jev answer, median | 282 ms | 160 ms |
| whole loop, median | ~330 ms | 177 ms |
| ticks that fit in 300 ms | 69% | 87% |
| ticks skipped as late | 42% | 8-12% |

Of those 282 ms, about 185 are round-trip travel to the API and the rest is the model thinking.
Shrinking the state sent to Jev changes nothing: a payload cut by 22% left the latency identical. The
move that works is putting the bot in the same region as the API, which is why `Dockerfile` and
`railway.json` are here: see `DEPLOY.md`.

## Costs, measured

| | value |
| --- | --- |
| Jev | **0.76 USD per hour** running (about 10,000 decisions, 86% of ticks) |
| Jev, per decision | 0.000074 USD (1,605 input tokens at 0.042 USD/Mtok) |
| gas, live only | 0.0357 MON per posted order, ~1.78 bps of a 200 MON order |

A dry run costs Jev credit and nothing else. At the time of writing the spread on MON-USDC is around
3.5 bps, so a full round trip earns about 2.6 bps gross while the two blocks of gas that carry it cost
about 3.6 bps: the demo is a demonstration of the pipeline, not a profitable strategy. `GUIDE.md` says
this in plainer words.

## Measuring the model, not just the code

    bun run scripts/score-decisions.ts   # hit rate, called-side bps, baselines and accuracy by confidence
    bun run scripts/analyze-session.ts   # the same decisions across several horizons, against the spread
    bun run scripts/collect-history.ts   # mirror a remote run into a local jsonl while it happens
    bun run scripts/bench-jev.ts         # latency and tokens per call, full vs trimmed payload
    bun run scripts/probe-jev-bias.ts    # five synthetic markets: does Jev read the data or repeat a habit

`score-decisions.ts` reads the recorded events, splits them into runs, and reports how often the
called direction was the direction price moved, with always-buy and always-sell for comparison.
Decisions overlap in time, so a few hundred of them are worth far fewer independent observations than
they look. `probe-jev-bias.ts` is the controlled check: the same question against markets that differ
only in trend strength, which is what a change to the question text in `src/model.ts` should be
measured with.

## What a measured session said

One 45 minute dry run on the US server: 5,360 block events, 4,006 decisions, 14% of blocks late. This
is the question the demo is really asking, and the answer was not the flattering one.

| horizon | scored | windows with no move | right | **right when it moved** | called side | always buy | mean abs move | move / spread |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 block | 4,005 | 74% | 13% | **48%** | 0.00 bps | -0.01 | 0.43 bps | 0.10x |
| 5 | 4,002 | 42% | 28% | **48%** | +0.02 bps | -0.05 | 1.14 bps | 0.25x |
| 10 | 3,998 | 30% | 33% | **47%** | -0.04 bps | -0.10 | 1.76 bps | 0.39x |
| 25 | 3,984 | 16% | 40% | **48%** | +0.04 bps | -0.19 | 3.05 bps | 0.68x |
| 50 | 3,964 | 7% | 45% | **48%** | +0.29 bps | -0.38 | 4.85 bps | 1.08x |
| 100 | 3,920 | 2% | 50% | **51%** | +0.10 bps | -0.74 | 7.73 bps | 1.72x |

Two things fall out of that table. The direction is a coin flip at every horizon the model is asked
about: 47 to 51% on four thousand decisions, with a called-side return indistinguishable from zero.
The "right" column looks terrible at short horizons only because the mid usually does not move at all
(74% of one-block windows), which is not a wrong call, it is a window with nothing to call.

And the structure cannot pay whatever the model says: at the horizon where the bot actually operates,
the mid travels 0.43 bps while the spread is 4.5 bps, and a full round trip captures
`spread - 2 ticks` = 3.6 bps against 3.6 bps of gas for the two blocks it takes. There is no
directional signal to find at that speed, and nothing left over once it is found.

The confidence analysis says the same thing from another angle: calls the model made with 90-100%
confidence, 58% of all of them, were right 41% of the time in one window and 88% in another. Two
windows, opposite answers, no usable information in the number.

## The adverse selection question

A maker's real risk is not being wrong about direction, it is being filled just before the price
runs. `src/model.ts` therefore asks a second question in the same request, at the cost of about 5%
more tokens: P(the mid moves further than the current spread within the horizon). It is a TypeSafe
`boolean` primitive, so the answer is a probability rather than a choice.

`MAX_BIG_MOVE` (default `1`) is the gate: with it at 1 the signal is recorded and acted on with
nothing. When a measured run says the answer is worth trusting, set it to a threshold like `0.6` and
the bot stops quoting while a big move is likely. Measure first, then act.

## Leaving the book clean

An order that is resting when the process dies keeps holding margin with nobody watching it. The
trader mirrors the ids of its live orders to `data/open-orders.json`, and on startup `Market.reconcile`
reads that file, asks the book which of those ids are still open, and cancels them in one
`batchCancelOrders` transaction before topping up margin. Dry runs skip it: they never place anything.
