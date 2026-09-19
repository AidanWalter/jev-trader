# Jev credit operating rules

This research path keeps Jev as the sole learned decision source. No distilled model, surrogate model, locally trained predictor, or other machine-learning model is permitted to substitute for Jev decisions. Deterministic code may transform Jev's direction probabilities into hold, exit, long, short, and exposure-size decisions, apply transaction-cost and risk constraints, allocate capital across assets, and evaluate historical outcomes.

Paid research uses one fixed apparatus before large-scale evaluation: the `jev-direction` evaluator, the compact `lean` state profile, an 8-bar forecast horizon on hourly BTCUSDT/ETHUSDT/SOLUSDT data, and an 8-bar decision cadence. The paid evaluator asks only the direction question and has retries disabled. Magnitude and adverse-selection questions are not purchased in this staged path.

The paid sequence is deliberately nested. The first stage evaluates 12 states. The next stage expands that exact prefix to 48 states, then 240, then 1,000. Only if the signal gates pass does development fill the remaining fixed train-plus-validation states. Only after deterministic policy tuning, cost stress, qualification, and the independent four-segment validation audit pass may the untouched sealed tail be evaluated.

Every paid stage is `workflow_dispatch` only and requires explicit spend confirmation. Starting with the 48-state stage, the operator must enter the exact request-count and input-token deltas shown by the TypeSafe dashboard for the preceding stage. The workflow refuses to continue unless those provider-side numbers reconcile closely with the saved artifact. This makes the provider dashboard, rather than local telemetry alone, the authority for whether another batch is allowed.

The six research stages have hard fresh-request ceilings of 12, 36, 192, 760, 5,996, and 1,000. Their configured dollar ceilings sum to $0.6825 at the pinned TypeSafe direct rate of $0.042 per million input tokens. The token-reservation model assumes 2,000 input tokens for every possible fresh request, giving a conservative reserved-token ceiling below $0.70 for the entire research chain. A workflow safety audit on both branches fails if these limits are loosened, a paid workflow gains an automatic trigger, the API key is exposed at job scope, concurrency exceeds one, or a legacy paid workflow becomes runnable.

The TypeSafe API key is scoped only to the individual step that performs Jev inference. Checkout, dependency installation, artifact download, validation, tuning, and reporting steps do not receive the key. Legacy paid workflows are hard-disabled.

Forward paper trading is also paid-budgeted. Frozen runners require `--confirm-paid=true` and explicit request, token, and dollar caps. Their persisted state records lifetime paid requests and provider-reported input tokens, and the remaining allowance is recomputed on restart. Restarting a paper process therefore cannot reset its Jev allowance. A hard spend-cap error or a TypeSafe 402/no-credit response stops the paid loop before another provider call.

No real exchange order is authorized by this research apparatus. Forward runners remain paper simulations unless a separate, explicit execution authorization and implementation is added later.

When new credit becomes available, the only intended first paid action is `jev-direction-canary`. Nothing else should be run until its 12-call artifact is compared with the TypeSafe dashboard and those numbers agree.
