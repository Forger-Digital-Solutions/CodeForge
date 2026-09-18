# Cerebras — R14 provider card

- Account/tier: authenticated organization; dashboard advertises a `$5` trial balance.
- Supply: `TRIAL_CREDIT`; not recurring Free.
- Models observed: `gpt-oss-120b`, `qwen-3.8-27b`.
- Limits: GPT-OSS 120B — 5 RPM, 2,400 RPD, 90,000 TPM, 3,000,000 TPD, 131,000 context,
  40,000 max completion. Qwen 3.8 27B — 450 RPM, 27,000 RPH, 648,000 RPD, 450,000 TPM,
  27,000,000 TPH, 648,000,000 TPD, 131,072 context, 40,960 max completion.
- Pool identity: organization/model quota shown separately; not counted because the supply is trial credit.
- Transport/policy: direct API; owner credential only; no new key or probe performed.
- Verdict: `TRIAL_CREDIT_ONLY` / `CEREBRAS_MANAGED_FREE_CERTIFIED = NO`.
- Provenance: authenticated Cerebras Limits page, 2026-09-18; provider definition and official pricing.
