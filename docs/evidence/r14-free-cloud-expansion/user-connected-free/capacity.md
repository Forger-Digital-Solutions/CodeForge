# Ollama user-connected Free Cloud — capacity model

Ollama Free accounts are modeled as one independent account pool with one concurrent request. The
pool is never multiplied into a centrally spendable company balance. For a connected user, the
fleet is `managed CodeForge Free + that user's Ollama pool`; for a disconnected user it is only
managed CodeForge Free.

The deterministic simulator accepts daily active users, adoption rates, included dollars per
connected user, estimated dollars per task, and shared-provider tasks per day.

With the illustrative inputs `373 DAU`, `$2` included usage per user, `$1` estimated task cost, and
`100` shared-provider tasks/day:

| Adoption | Connected users | Added Free tasks/day | Shared pressure offloaded |
|---:|---:|---:|---:|
| 0% | 0 | 0 | 0 |
| 10% | 37 | 74 | 74 |
| 25% | 93 | 186 | 100 |
| 50% | 186 | 372 | 100 |
| 75% | 279 | 558 | 100 |

These are derived scenarios, not an Ollama account entitlement or a claim about current Free
balance. The actual gain is `floor(observed included balance / estimated task cost)` for each user,
with the one-slot concurrency limit and the free-only guard applied before dispatch.
