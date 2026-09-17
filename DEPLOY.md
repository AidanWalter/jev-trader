# Running the bot on a server

## Why a server is needed

The bot has 300 milliseconds per tick. Jev's answer travels to its computers and back: **185
milliseconds are pure travel**. From a home connection that is 185 for the trip plus ~100 for the
thinking, about 280 ms against a 300 ms tick: always a photo finish, and 42% of the ticks were
skipped.

On a machine in the same region as Jev the trip almost disappears. Measured on Railway US East:

| | home connection | Railway, US East |
| --- | --- | --- |
| reading the book | 35 ms | 17 ms |
| Jev's answer, median | 282 ms | 160 ms |
| whole loop, median | ~330 ms | 177 ms |
| ticks that fit in 300 ms | 69% | 87% |
| ticks skipped | 42% | 8-12% |

No code needs to be written for this: the repository already contains the `Dockerfile`, the recipe
that tells a machine how to start the program.

## What you need

- the code on GitHub
- an account on Railway (simplest), or Fly.io, Render, or a server of your own
- the Jev key

## Steps with Railway

1. Go to railway.app and sign in with GitHub.
2. `New Project` → `Deploy from GitHub repo` → pick the repository.
3. Railway finds the `Dockerfile` by itself, thanks to the included `railway.json`.
4. In `Settings` → `Variables` add the following.

   | Name | Value |
   | --- | --- |
   | `MODEL` | `jev` |
   | `TYPESAFE_AI_API_KEY` | your key |
   | `DRY_RUN` | `true` for now (a dry run, no money) |
   | `RPC_URL` | `https://rpc.monad.xyz` |
   | `READ_RPC_URL` | `https://rpc.monad.xyz` |
   | `WS_URL` | `wss://rpc.monad.xyz` |
   | `TRADE_SIZE_MON` | `200` |
   | `MAX_POSITION_MON` | `400` |
   | `MARGIN_MON` | `200` |
   | `MARGIN_USDC` | `5` |

   **Do not set `PORT`**: Railway decides it and the program reads it from the environment.

   Railway has a `Raw Editor` button where the whole block can be pasted at once. Replace only
   `paste_your_key_here`:

   ```
   MODEL=jev
   DRY_RUN=true
   TYPESAFE_AI_API_KEY=paste_your_key_here
   RPC_URL=https://rpc.monad.xyz
   READ_RPC_URL=https://rpc.monad.xyz
   WS_URL=wss://rpc.monad.xyz
   TRADE_SIZE_MON=200
   MAX_POSITION_MON=400
   MARGIN_MON=200
   MARGIN_USDC=5
   ```

5. In `Settings` → `Region` choose **US East (Virginia)**. This is the choice that removes the delay.
6. `Deploy` and watch the logs.

## How to tell it worked

- the logs must show a line like `jev-trader · model=jev-latest · ... DRY RUN` (if it says
  `model=mock`, the variables were not applied)
- further down, lines with `loop XXXms`: from home they sit between 330 and 700, on the server they
  must stay below 300
- opening the service address in a browser must return a block of JSON

## The dashboard

The dashboard is a second program (the `web/` folder) and is deployed separately, for example on
Vercel:

1. Vercel → `Add New Project` → import the same repository
2. set `Root Directory` to the `web` folder
3. add the variable `NEXT_PUBLIC_API_URL` with the backend address on Railway, for example
   `https://your-service.up.railway.app`
4. after the deploy, open the address Vercel gives you

Running the dashboard on your own machine is also fine: put the same address in `web/.env.local` and
start it with `bun x next dev -p 3200`.

## What it costs

- **server**: a few dollars per month (Railway starts at about 5). The free trial credit covers a
  small service like this for a while
- **Jev**: 0.76 dollars per hour of running, measured. Roughly 18 dollars for a full day
- **gas**: only with real money, see `GUIDE.md`

The bot consumes Jev credit even when the market is quiet, because it asks a question on almost every
tick. Turn it off when you are not watching: `Deployments` → `⋯` → `Remove`.

## If you would rather not rent anything

Everything keeps working from your own machine: 42% of the ticks are skipped, but the program runs,
the dashboard shows everything, and it costs nothing. That is the right mode while you are studying.
