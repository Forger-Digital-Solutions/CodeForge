# R84 quota-domain map

| Source | Actual or declared quota owner | Evidence limit |
|---|---|---|
| Kilo anonymous | Public source IP; shared across Free models/NAT clients | Documented 200/hour is a ceiling, not observed remaining quota; upstream sharing unknown |
| BlockRun anonymous | Public source IP, shared Free model allowance | Documented 30/minute and 300/hour; cross-gateway upstream independence unknown |
| AI Horde | Shared global worker pool; anonymous low-priority queue | Model/worker count is not reserved capacity |
| OpenRouter optional | Authorized account/organization | Live entitlement needed; multiple keys/models do not multiply quota |
| Groq optional | Organization with model-specific limits | Multiple organization keys share ownership |
| Workers AI optional | Cloudflare account allocation and plan | Existing neuron guard; operator account not measured |
| CodeForge hosted/sponsored/GEMS | Actual operator contract or entitlement, if supplied | Not demonstrated here |

Durable turns preserve user-scoped logical quotaDomainId. These ids are isolation handles, not proof of physically independent source-IP allowances. The new governor waiting tickets preserve FIFO eligibility without splitting the existing ledger. Existing quota-domain, token-bucket, isolation and exhaustion fixtures pass. Gate H remains PARTIAL because remote NAT usage and shared upstream domains are not observed.
