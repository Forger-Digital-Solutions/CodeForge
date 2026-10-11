# R84 two-project fairness

The existing ProviderCapacityGovernor now queues identifiable eligible tickets. An already waiting project precedes another project’s newly arriving request. Quota/cooldown-blocked model tickets do not hold up eligible siblings, and cancellation removes a ticket in finally. Provider concurrency and token/rate reservations remain the same authorities.

New deterministic tests exercise project A holding the only slot, project B waiting, A attempting another turn, B receiving the next slot, and cancellation releasing queue state. Existing two-user, session-isolation, parallel cancellation/contracts/orchestrator recovery and quota-domain suites were executed. See fairness-recovery-tests.json, eligibility-recovery-tests.json and repository-tests.json when available. These fixture runs verify isolation contracts and absence of queued starvation, not two independently provisioned quotas or two full-speed live streams.

The two live coding fixtures were sequential. Two concurrent live projects remain NOT RUN. No new account manager, scheduler, project slots or billing ledger was added. Workspace ownership, tools and checkpoints remain with the existing server runtime.
