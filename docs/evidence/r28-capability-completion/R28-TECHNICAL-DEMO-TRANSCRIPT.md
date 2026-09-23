# CodeForge R28 technical demo — 2026-09-23T18:44:54.756Z

Scene 1 — boot the production server with desktop-identical provider wiring.
    provider 'openrouter' live catalog: 456 models listed, 24 verified free → ForgeZero
    server listening on 127.0.0.1:51897 — the same createServer the desktop embeds

Scene 2 — routing fabric: what the model selector actually sees.
    /api/models → 35 records, 25 verified-free
    · openrouter/stealth/space-bunny-alpha — Space Bunny Alpha
    · openrouter/nex-agi/nex-n2.5-mini:free — Nex-N2.5-Mini (free)
    · openrouter/nex-agi/nex-n2.5-pro:free — Nex-N2.5-Pro (free)
    · openrouter/inclusionai/ling-3.0-flash-sante:free — Ling 3.0 Flash Sante (free)
    · openrouter/inclusionai/ling-3.0-flash-fin:free — Ling 3.0 Flash Fin (free)
    unauthenticated /api/workflow/list → HTTP 401 (control-plane bearer enforced)

Scene 3 — workspace.
    /api/workspace/set → 200 (fixture)
    /api/repository-index/status → 200 {"state":"READY","workspaceId":"c6c13ec2077c50462d543889490dd499a15ebdbb","repositoryNamespace":"12388be09d1168ca64de6147c48f1d3aaefd533f547

Scene 4 — task: "The add() function in src/math.js returns the wrong result. Fix it so add(2, 3) returns 5 without ch…"
    /api/model-selection → 200 {"providerId":"openrouter","modelId":"nex-agi/nex-n2.5-mini:free","tier":"free","lock":"model"}
    /api/workflow/run → 200 taskId=f3c3d609-e1b1-4ab4-b025-50e3a5ce1233
      …phase → implementing
      …phase → completed

Scene 5 — verdict.
    workflow status=complete phase=completed
    completion gate outcome=completed — "All required completion checks passed."
    hidden verifier → PASS (independent of the workflow's own verification)
    persisted work items: plan, eight_bit_route_state, agent_final_response, verification, run_inspection, evidence
    events: 239

Scene 6 — fail-closed: ForgeZero refuses a route it never verified.
    /api/model-selection unverified route → 400 {"error":"MODEL_NOT_FOUND","message":"Unknown model openrouter/anthropic/claude-3.5-sonnet"}

**Demo verdict: COMPLETE** — workflow complete, gate completed, hidden verifier pass, unverified route refused=true
