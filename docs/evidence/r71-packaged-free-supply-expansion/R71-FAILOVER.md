# R71 failures, failover and recovery

Organic failures are preserved: Kilo Poolside returned HTTP 429; Kilo auto returned an error envelope with code 503 inside HTTP 200; the real autonomous feature attempt hit Cohere upstream HTTP 429 and produced `NO_ELIGIBLE_ROUTE`, then a blocked parent run. No paid or local fallback occurred.

R71 fixes the production response chain: trusted gateway scope → typed ProviderError/SSE event → governor → FreeCloudService observer → owner/domain-scoped route health → agent execution. Kilo's own IP/account/quota/credit wording wins over conflicting model wording. A credible upstream model 429 can leave sibling models selectable within the **same physical parent quota**. Unknown scope remains whole-domain. Response observations are emitted once, embedded errors fail, no-choices fails, and internal timeout is not empty stream success. Explicit caller cancellation remains cancellation.

The corrected direct transport sequence shows a subsequent named-model answer after the auto error, but it manually calls the two transports. It does **not** establish actual production automatic failover following that 503. Production 503 health remains conservatively domain scoped. The campaign's only qualified coder sibling was exhausted, so it blocked rather than showing a successful automatic replacement.

Deterministic production seam, governor/health isolation, cooldown expiry, persisted state and owner-bound hydration regressions pass. Existing autonomous-parent recovery tests also pass across actual child processes, covering durable waiting and restart without replaying committed mutations. Those are process integration tests with scripted inference, not fresh live provider recovery measurements.

Gate E is **PARTIAL**: organic failure handling is proven; successful organic production failover followed by verified autonomous completion is not proven. Do not use R70 controlled cooldown evidence or the invalid initial 200 diagnostic to close it.
