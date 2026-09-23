# R27 Proof Ledger

Status: `R27_INTELLIGENCE_IMPROVED_WITH_BLOCKERS`

| Subsystem | Deterministic | Live | Packaged | Hardware |
| --- | --- | --- | --- | --- |
| Core runtime | Proven | Bounded runtime slice proven | Not proven | Not proven |
| ForgeGreen | Proven mechanism | Not proven | Not proven | Not proven |
| 8-Bit | Proven | Not proven | Not proven | Not proven |
| 16-Bit | Proven quarantine | Blocked by free-only policy | Not proven | Not proven |
| ForgeVerify | Proven | Not proven | Not proven | Not proven |
| Subagents | Proven in scripted comparison | Not proven | Not proven | Not proven |
| Planner | Proven protocol compatibility | Not proven | Not proven | Not proven |
| Context and memory | Proven bounded/freshness behavior | Context refresh slice proven | Not proven | Not proven |
| Browser and terminal | Proven local runtime behavior | Not proven | Not proven | Not proven |
| Git and GitHub | Proven local contracts | Not proven | Not proven | Not proven |
| Permissions | Historical R26 test evidence only | Not proven | Not proven | Not proven |
| Live provider preflight | Not applicable | Bounded free route proven | Not proven | Not proven |
| Recovery and endurance | Proven deterministic stress | Not proven | Not proven | Not proven |
| Single-user performance | Proven synthetic guard bounds | Not proven | Not proven | Not proven |
| Packaged desktop | Historical R26 tests only | Not proven | Fresh bytes audited; smoke blocked | Host renderer blocker reproduced |

The machine-readable [proof ledger](R27-PROOF-LEDGER.json) carries the complete evidence mapping
and source references. [The live preflight receipt](R27-LIVE-PREFLIGHT-EVIDENCE.json) proves only
a tightly bounded route/runtime slice; it does not promote that slice into completion-gated
workflow success, endurance, current-packaged, or hardware claims.

The final [intelligence certification report](R27-FINAL-INTELLIGENCE-CERTIFICATION.md) records the
current-source package, exact artifact hashes, live sample counts, and the startup blocker.
