# R14 fleet capacity inputs — 2026-09-18

This is the sanitized capacity input set used for the R14 certification decision. A route is
included in the production forecast only after exact price, lifecycle, privacy, managed-use terms,
and current capacity evidence all pass. Dashboard limits that fail one of those gates remain
evidence, not usable product capacity.

| Candidate | Physical identity | Observed dimensions | Counted in Managed Free |
|---|---|---|---:|
| Groq GPT-OSS/Qwen | authenticated organization/project | 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD per listed model; shared-vs-model-specific unresolved | No |
| Cerebras | authenticated organization/model | GPT-OSS 5 RPM / 2,400 RPD / 90K TPM / 3M TPD; Qwen 450 RPM / 648K RPD / 450K TPM / 648M TPD | No — trial credit |
| Gemini Developer | authenticated project/model | Tier 1 model limits; unpaid billing state and private-code policy unresolved | No |
| Mistral | authenticated Free account | included monthly allowance; model ceilings observed; training allowed by current setting | No |
| Cloudflare Workers AI | authenticated account | 10,000 neurons/day allocation, but account is Workers Paid and overage is billable | No |
| OpenRouter exact `:free` | authenticated account/workspace | `$25` existing balance unlocks documented higher allowance; current remaining counter unobserved | No — deposit-unlocked and agreement-gated |
| Kilo exact `:free` | end-user/IP | 200 requests/hour/IP documented; token/privacy/terms evidence incomplete | No |
| Ollama Cloud | owner subscription | one concurrent request; Free usage 0% used, reset in five days; monthly token amount unknown; `$0` usage credits and auto-reload off | No — owner-only candidate |

Production-approved Managed Free pools: **0**.

Owner-only candidates: **1** (Ollama Cloud), with safe token capacity unknown and no hard-stop API
receipt yet. Distributed per-user pools approved for routing: **0**.
