# R31 Platform Golden Task — Evidence

The required golden task is a packaged, authenticated, multi-capability
workflow on the final binary. Evidence is drawn from the packaged smoke
`full` mode on `win-unpacked/CodeForge.exe` (the exact R31 artifact,
SHA-256 `0079d559…`) — not a dev server, not mocks.

## Executed (packaged, real)

| Capability | Proof |
|---|---|
| Launch packaged binary | `PACKAGED_STARTUP=PASS` |
| Authenticate / restore session | `packaged_auth_restore=PASS` |
| Authenticated workspace | `packaged_authenticated_workspace=PASS` |
| Repository index + query | `repository index READY, 258 files, query-known-answer PASS` |
| Run a real workflow (terminal state via completion gate) | `packaged_workflow=PASS`, `TASK_TERMINAL_PHASE_completed` |
| Failure-repair path | `packaged_failure_repair_pass=PASS` |
| Control-plane auth | missing/wrong/forged bearer + origin + secondary-renderer all rejected |
| Workspace escape | `packaged_workspace_escape_blocked=PASS` |
| Extension loaded + invoked as capability | `packaged_extension_command=PASS` |
| Extension lifecycle | `packaged_extension_lifecycle=PASS` |
| Settings roundtrip + invalid rejection | PASS |
| Credential encrypt/restore | `credential_encrypted_payload`, `credential_restart_decrypt` |
| Updater status/check/install-guard | PASS (check unavailable — no update server, honest) |
| Restart persistence + no approval replay | recover mode PASS |

## Orchestration judgement

Per §29 the agent prefers structured tools over GUI automation where a
structured path exists — the packaged workflow used workspace tools,
repository index, and the extension command bridge rather than Computer
Use, which is the correct routing. Computer Use and Browser were
independently proven live (real 1920×1080 screenshot + local page
inspect/click/type, dirs `20-*`).

## Residual gap (honest)

The packaged workflow's coding steps ran on the packaged binary but, in
smoke mode, against its scripted smoke provider path
(`WHEN_READY_SMOKE_PROV_DONE`) — not a live free cloud provider. Live
provider coding on this exact binary is covered separately by the
`10-live-acceptance` receipts, which exercise the same workflow service
and completion gate. A single packaged task that simultaneously (a) uses
a live free provider and (b) runs inside the packaged binary has no
dedicated receipt — the two properties are proven independently.
