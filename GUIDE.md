# Jev Trader, explained simply

This guide explains the program in plain words, without trading jargon. `README.md` stays the
technical reference.

## What it does, in plain words

On Monad there are "blocks": they are like the ticks of a clock, one every ~0.3 seconds. Inside each
tick the program does four things:

1. **Looks at the prices.** It asks the blockchain how the MON/USDC market on Kuru is doing: who
   wants to sell at what price, who wants to buy at what price.
2. **Asks the AI (Jev) for an opinion.** It sends a summary of the order book and asks one question:
   will the price be higher or lower in a bit?
3. **Posts an advert.** It writes a real order on the blockchain: "buy 200 MON at this price" or
   "sell 200 MON at this price". In the same transaction it cancels the advert from the previous
   tick, so they do not pile up.
4. **Records what happened** and streams it to the dashboard, which is the web page you watch.

The advert does not attack the market: it queues up and waits. If somebody takes it, a trade happened
(a "fill"). That is how the program earns the gap between the buying and the selling price instead of
paying it.

## Dry run versus real money

- **Dry run:** it reads real prices and Jev really decides, but no order is written on the blockchain
  and no money moves. Trades are simulated. This is the default.
- **Live:** it needs the private key of a wallet holding MON (for network fees) and USDC (to buy).
  Orders really land on the market.

The mode comes from the `.env` file: if `PRIVATE_KEY` is empty it is always a dry run.

## How to start it

Bun is required.

```powershell
# 1. the brain: reads the market and decides
cd path\to\jev-trader         # the folder where you cloned the repository
bun run src/index.ts          # listens on http://localhost:3100

# 2. the dashboard: the page you watch
cd web
bun x next dev -p 3200        # open http://localhost:3200
```

Stop them with `Ctrl+C` in the window where they run.

Note: port 3000 is usually taken by other projects, so the brain uses 3100 and the dashboard uses
3200. The dashboard knows where to find the brain through `web/.env.local`.

## What the numbers on screen mean

| Item | Meaning |
| --- | --- |
| **block** | the tick number of the chain clock. It grows by itself, one every ~0.3 s. |
| **buy % / sell %** | how convinced Jev is of one direction. 100% = certain, 50% = undecided. |
| **latency** | how long Jev took to answer, in milliseconds. |
| **late** | the tick went by while Jev was still thinking: nothing was done that round. |
| **spread** | the distance between the lowest price somebody sells at and the highest price somebody buys at. It is the theoretical maximum earning of one trade. |
| **fills** | how many times somebody took one of our adverts. |
| **gas** | the network fee for writing to the blockchain. Paid on every tick that posts an order. |
| **P&L** | total profit or loss, in dollars. In a dry run it is simulated and must be read carefully. |
| **capped** | Jev's decision could not be executed (too much inventory already, or no funds left), so the opposite side was quoted to reduce it. |

## What it costs

Measured on a live dry run, not estimated:

| | value |
| --- | --- |
| ticks per minute | ~200 (one every 300 ms) |
| decisions paid for | ~10,000 per hour (86% of ticks) |
| **Jev cost** | **0.76 dollars per hour** |
| cost of a full day running | ~18 dollars |
| cost of one decision | 0.000074 dollars |
| gas per posted order (live only) | 0.0357 MON, ~1.78 bps of a 200 MON order |

Jev credit is only spent **while the bot runs**: stopped, it costs nothing. Gas is only paid with real
money, so in a dry run the only cost is Jev.

## Stopping it, so the credit stops burning

Railway has no pause button, and its `Serverless` feature (formerly App Sleeping) does not help here:
it sleeps a service after 5-10 minutes without outbound traffic, and this bot talks to the blockchain
dozens of times per second, so it never looks idle. The reliable way is to remove the deployment:

1. service → `Deployments`
2. on the active deployment, the `⋯` menu on the right → `Remove`
3. to start it again: `Deployments` → `Deploy`

## The permanent disk

Collected data lives inside the container and is lost at every restart unless a volume is attached.
In Railway: right click on the project canvas (or `Ctrl+K`) → create a volume → pick the service →
**mount path `/app/data`**.

That path is not arbitrary: the program writes to `data/` and Railway runs it inside `/app`, so the
volume must be mounted exactly at `/app/data`. A volume on `/data` would be attached in the wrong
place and the files would keep disappearing. A volume is attached only when a new container is
created, so a new deploy is needed after creating it.

To check that it really works, from the Railway `Console` tab:

```
printenv | grep RAILWAY_VOLUME     # must print RAILWAY_VOLUME_MOUNT_PATH=/app/data
ls -la /app/data                   # must contain events.jsonl and a lost+found folder
wc -l /app/data/events.jsonl       # write this number down
```

The `lost+found` folder is the proof that it is a real disk rather than an ordinary folder. Then
redeploy and run `wc -l` again: if the number is higher than before, the data survived.

## When something goes wrong

**The process dies while an order is on the market.** The order stays there and keeps part of the
money locked in the margin account. On restart the program now notices by itself: it reads the saved
list in `data/open-orders.json`, asks the chain which of those orders are still open, and cancels
them before starting again. If the cancel fails, the list stays in the file and it retries next run.

**I want to cancel everything by hand.** Open orders can be seen and cancelled from the Kuru website
by connecting the same wallet. Collateral is withdrawn with the `withdraw` function of the
MarginAccount contract: the money is not lost, it is only locked while an order is open.

**An order shows up as "lost".** That means no confirmation arrived within 10 ticks. Most of the time
the transaction never landed. In a rare case it can land late, and then the order exists but the
program does not know its number: check it by hand from the website.

## Before using real money

1. Create a **new, dedicated wallet**, never the main one, and put in it only what you are willing to
   lose.
2. You need **MON** (for gas and for sell orders) and **USDC** (for buy orders) on the Monad network.
3. Set small limits in `.env`: `TRADE_SIZE_MON=200` (the market minimum), `MAX_POSITION_MON=400`,
   `MARGIN_MON=200`, `MARGIN_USDC=5`.
4. Do one short session of about fifteen minutes with a clear goal: check that orders really land on
   the market, that fills arrive, and that nothing is left hanging at the end. Do not expect profit.
5. Keep `DRY_RUN=true` until you have read everything here.

## Measuring tools

```powershell
bun run scripts/bench-jev.ts          # how fast Jev is and what each answer costs
bun run scripts/probe-jev-bias.ts     # five synthetic markets: does Jev read the data or repeat a habit
bun run scripts/score-decisions.ts    # replays past decisions and says how many were right
bun run scripts/trades-smoke.ts       # how many trades the market saw in the last hour
bun run scripts/bench-read.ts         # how long reading the prices takes
```

`score-decisions.ts` is the important one: it says whether Jev has real judgement or is guessing.
Until that number is good, no amount of money is worth risking.
