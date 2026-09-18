# Groq — R14 provider card

- Account/tier: authenticated Personal organization, Default Project; project has no custom limits.
- Supply candidate: recurring account free allowance, pending managed-use confirmation.
- Models observed: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`,
  `openai/gpt-oss-safeguard-20b`, `qwen/qwen3.8-27b`.
- Limits: the listed GPT-OSS/Qwen routes each show 30 RPM, 1,000 RPD, 8,000 TPM, and 200,000
  TPD. The dashboard says these are inherited organization limits; whether tokens are shared
  across models is not proven.
- Pool identity: `groq` organization/project boundary; model-specific versus shared token pool
  requires bounded response-header probes.
- Privacy/terms: no default retention is documented, but the service agreement/resale boundary
  is not cleared for a CodeForge-managed multi-user key in this card.
- Verdict: `POLICY_REVIEW`; not counted until intermediary terms, exact model price, and runtime
  headers are certified.
- Provenance: authenticated project and organization Limits pages, 2026-09-18; public Groq data
  controls and Services Agreement linked from the account card.
