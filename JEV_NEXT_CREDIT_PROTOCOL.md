# Jev next-credit protocol

This repository must treat the next Jev credit balance as scarce research capital. No paid Jev workflow may run automatically. Paid calls must remain manual, serial, cache-backed, and guarded by both a fresh-request ceiling and a conservative input-token/dollar reservation before each provider call.

Jev remains the decision model. Do not distill Jev into another model, do not substitute a surrogate model for live decisions, and do not train a conventional ML model to make the decisions assigned to Jev. The research policy may deterministically transform Jev's direction probabilities into hold, exit, long, short, and position-size targets, and may tune those deterministic thresholds using cached Jev outputs.

The fixed paid research sequence is:

| Stage | Total states | Fresh calls allowed | Hard stage cap | Escalation requirement |
| --- | ---: | ---: | ---: | --- |
| Canary | 12 | 12 | $0.0015 | Compare artifact request/token counts with TypeSafe dashboard |
| Sample | 48 | 36 | $0.004 | Exact provider billing reconciliation |
| Sample | 240 | 192 | $0.017 | Exact provider billing reconciliation plus modest signal gate |
| Sample | 1,000 | 760 | $0.065 | Exact provider billing reconciliation plus robust multi-regime/multi-asset signal gate |
| Development | full fixed dev set | 5,996 | $0.505 | Exact provider billing reconciliation, deterministic policy tuning only, all validation segments positive |
| Sealed | frozen test only | at most 1,000 | $0.09 | Exact provider billing reconciliation, qualified frozen apparatus, one-time sealed evaluation |

The configured maximum across the entire research sequence is 7,996 fresh requests and $0.6825. If any stage fails its signal, validation, billing-reconciliation, cache-identity, duplicate-artifact, or spend-cap check, stop there. Do not compensate by increasing the budget or changing the sealed test.

The paid evaluator is `jev-direction` with the `lean` state profile and one direction question only. Its current fixed research horizon is eight hourly bars. The 12, 48, 240, and 1,000-state samples are deterministic nested prefixes across assets and time regimes, so later stages reuse every earlier paid answer.

Before each escalation after the first canary, record the exact TypeSafe dashboard request-count delta and input-token delta caused by the preceding stage. The next workflow refuses to run unless those values reconcile with its saved artifact. This provider-side reconciliation is the authority for whether the local cost telemetry is trustworthy.

Paid live paper remains separately locked. It requires an explicit `--confirm-paid=true` flag and explicit spend caps. Its request and input-token usage is persisted in the paper state so restarting the process does not reset the lifetime allowance. Spend-cap exhaustion or an HTTP 402/no-credit response terminates paid live paper before further provider calls.

Legacy paid workflows remain hard-disabled. The CI safety audit rejects paid workflows that are not manual-only, expose the API key at job scope, omit a dollar cap, allow paid concurrency above one, or change the pinned staged ceilings.
