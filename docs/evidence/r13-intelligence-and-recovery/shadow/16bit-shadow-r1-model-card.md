# 16bit-shadow-r1 model card

State: **SHADOW ONLY**

Purpose: estimate verified success, availability risk, latency band, and expected task-cost evidence for a deterministic Paid Auto choice. The prediction surface receives only decimal cost evidence and has no budget ledger, provider adapter, or request execution method.

The candidate uses the shared calibrated-linear format once the training threshold is met. Current state is baseline-only and `INSUFFICIENT_DATA`; no live paid call was made and no R13 spend was incurred to create training data.

It may never reserve or release money, alter campaign budgets, authorize spending, choose a paid route, route Free to paid, route Paid Auto to BYOK, or override completion/verification. The existing deterministic integer-micro USD ledger remains money authority.
