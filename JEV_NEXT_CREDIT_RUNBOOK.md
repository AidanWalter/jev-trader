# Jev next-credit runbook

This repository must treat TypeSafe/Jev credit as a finite bankroll.

## Non-negotiable rules

Paid Jev workflows are manual-only. The only allowed paid workflow chain on the default branch is:

`jev-direction-canary` → `jev-direction-sample` → `jev-direction-development` → `jev-direction-sealed`.

`.github/workflows/jev-workflow-safety.yml` audits every workflow that can see `TYPESAFE_AI_API_KEY`. Any legacy paid workflow must remain hard-disabled. The Jev secret is scoped only to the individual paid step, never checkout, install, artifact download, or the whole job.

No distillation model, surrogate model, or conventional ML model is allowed to make the trading decision. Jev supplies the direction probability distribution. Position sizing, abstention, execution, portfolio allocation, and risk limits are deterministic code.

No paid stage is automatically launched by another paid stage.

## Stage 1: twelve-call canary

Workflow: `jev-direction-canary`.

Fixed apparatus: BTCUSDT / ETHUSDT / SOLUSDT, one-hour bars, 8-bar forecast horizon, decision cadence 8 bars, `lean` input profile, one Jev question only: long / flat / short.

The state JSON is regression-tested to remain under 1 KB. The evaluator has zero retries and concurrency 1.

Hard envelope: at most 12 fresh provider requests, at most 30,000 reported input tokens, 2,000 tokens reserved before each request, and a hard ledger ceiling of $0.0015 at $0.042/MTok.

The canary uses the exact frozen 2024-01-01 through 2026-09-01 market artifact. It also compares the new lean answer with the already-paid full-Jev path/8h answer on the same states when available.

Only a successful canary creates the deterministic `jev-direction-canary-v1` artifact. A failed canary produces a run-specific diagnostic artifact and does not consume the one-time success lock.

STOP after this stage. Check the TypeSafe dashboard manually. Do not trust only repository telemetry.

## Stage 2: 240-state nested sample

Workflow: `jev-direction-sample`.

This stage requires the successful canary run ID plus explicit confirmation that the TypeSafe dashboard matched the canary artifact. Sampling is deterministic and nested, so the first 12 states are the canary states and are cache hits rather than repaid requests.

The 12 canary states are an exact nested prefix and must already be cached. Hard envelope for this stage: at most 228 fresh requests, at most 456,000 input tokens, 2,000-token reservation per request, hard ledger ceiling $0.020, concurrency 1. If at least 12 selected states are not cache hits, the stage refuses to start.

The next stage is blocked unless the sample still averages no more than 1,600 input tokens/request, has Brier score below the three-class uniform benchmark, produces at least 40 non-flat calls, and contains a confidence/edge subset with at least 30 observations and more than 3 cost-adjusted bps per state.

STOP after this stage and reconcile the TypeSafe dashboard again.

## Stage 3: fixed development apparatus

Workflow: `jev-direction-development`.

This stage requires the successful 240-state sample run ID, explicit dashboard verification, and explicit spend approval.

Only one Jev apparatus is filled: `jev-direction`, `lean`, horizon 8, base decision cadence 8. The already-paid 240 nested states are reused. There is no Jev profile × horizon sweep.

The 240 sampled states are a nested subset of the fixed 6,996-state development apparatus and must already be cached. Hard envelope for this stage: at most 6,756 fresh requests, at most 13,512,000 input tokens, 2,000-token reservation per request, hard ledger ceiling $0.57, concurrency 1. The pilot counts missing states before calling Jev and refuses the cell if more than 6,756 are missing.

After caching, all policy tuning is zero-cost deterministic replay. The tuner is explicitly direction-only. A freeze is produced only if the apparatus passes nominal validation, 1.5x and 2x cost stress, minimum fill count, and every chronological validation segment. A second independent four-segment audit requires all four segments positive.

No sealed data is evaluated here.

STOP after this stage and reconcile the TypeSafe dashboard again.

## Stage 4: one-time sealed test

Workflow: `jev-direction-sealed`.

This stage requires a qualified frozen apparatus, a passing independent validation audit, the development run ID, explicit dashboard verification, and explicit spend approval.

A zero-spend preflight counts missing sealed Jev states before the paid step. The current workflow refuses more than 1,000 missing states. If the frozen cadence requires more, stop and change the cap deliberately rather than silently expanding it.

Current hard envelope: at most 1,000 fresh requests, at most 2,000,000 input tokens, 2,000-token reservation per request, hard ledger ceiling $0.09, concurrency 1.

The successful sealed artifact is locked to the development run so the same sealed test cannot be paid for twice.

## Maximum planned exposure

The nominal workflow ceilings sum to $0.6815: $0.0015 canary + $0.020 sample + $0.57 development + $0.09 sealed.

Those are hard repository-side ceilings, not estimates of expected spend. The process also requires manual provider-dashboard reconciliation after the canary, sample, and development stages. If TypeSafe usage disagrees materially with the artifact, stop immediately and do not proceed.

## What the already-paid cache tells us

A zero-cost forensic audit found that the old multi-question/full-state Jev outputs were generally weak after modeled transaction costs.

A cache-only direction-only retune across completed generation-two cells did not produce a qualified apparatus. The best aggregate candidate was path / 12-hour horizon at cadence 32 with +2.33% nominal validation, but three of four chronological validation segments were non-positive, so it failed qualification.

That old result does not validate the new lean one-question prompt. It is a reason to keep the new experiment staged and small.

## When new credit arrives

Do not re-enable legacy workflows.

Run only `jev-direction-canary` first. After it completes, compare its request count and token usage with the TypeSafe dashboard before doing anything else.
