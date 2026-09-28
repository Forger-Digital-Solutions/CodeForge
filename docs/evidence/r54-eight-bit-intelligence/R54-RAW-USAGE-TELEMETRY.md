# R54 raw inference usage foundation

Each durable `agent_model_turn` record now carries served provider/model, provider usage provenance, input/output tokens when reported, transcript bytes, finish reason, and tool-request count. The live mission harness exports these with the role journal and per-turn tool/edit trace. When the provider does not report usage, exported token fields are `null` with `usageSource: UNKNOWN`; no tokens or normalized Shillings are fabricated. The mission receipt still records paid spend and route eligibility separately.

Total tokens, provider allowance units, and normalized Shillings remain UNKNOWN where upstream APIs do not provide them. This is a metering foundation only; routing and billing do not use it.
