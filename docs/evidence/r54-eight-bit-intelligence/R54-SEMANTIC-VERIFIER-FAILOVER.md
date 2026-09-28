# R54 alternate semantic Reviewer

If the first role-routed Reviewer returns no valid verdict, the orchestrator attempts one fresh Reviewer on the same diff and worktree. Fresh free admission excludes the first route and retains the implementer-pool independence preference. The prior non-verdict cannot approve the patch. A durable `semantic_verifier_handoff` receipt stores both routes, the diff hash, and the fact that the first verdict was absent. The replacement route emits `SEMANTIC_VERIFIER_FALLBACK`.

The deterministic production-orchestrator test makes Reviewer A exhaust its turn budget without a verdict, then accepts Reviewer B's structured pass; independent tests and the completion gate pass afterward. A second test makes B return no verdict and confirms that the run stays blocked. The real Free Fabric route-exclusion path is tested separately. Live alternate-reviewer execution remains pending.
