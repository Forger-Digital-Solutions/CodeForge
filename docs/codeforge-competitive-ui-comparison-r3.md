# CodeForge R3 screenshot-driven implementation evidence

## Reference concepts and CodeForge-native result

| Reference concept | Before R3 | R3 implementation | Primary source | Packaged evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Useful, repository-aware home | Empty activity panel could dominate a new workspace | Empty analytics is suppressed; repository brief, six useful actions, routing/model context, and integrated composer remain | `packages/ui/src/Conversation.tsx` | `01-authenticated-zero-state.png`, `02-workspace-ready.png` | Verified |
| Task-first sidebar | Refresh could briefly show stale phase text | One session is one row; terminal SSE state immediately overlays stale summary data | `packages/ui/src/Navigation.tsx`, `WorkspaceApp.tsx` | `03-workflow-completed.png` | Verified |
| Calm task narrative | Raw event/tool sequence had too much equal visual weight | Adjacent completed reads are grouped; completed plans and approvals collapse to concise, expandable audit rows | `packages/ui/src/Conversation.tsx` | `03-workflow-completed.png` | Verified |
| Inline command cards | Commands were not consistently readable task artifacts | Collapsed cards show command plus result; expansion retains exact command, output, and exit code | `packages/ui/src/Conversation.tsx`, `workspace.css` | Source/test verified; dedicated capture not yet automated | Implemented, capture gap |
| Clear approval decision | Resolved approval rows consumed thread height | Live approvals use plain-language reason/scope/risk and explicit Allow once/Allow for task/Deny; resolved rows remain expandable | `packages/ui/src/ApprovalBar.tsx` | `03-workflow-completed.png` | Verified |
| Failure and recovery | Raw error line | Human-readable failure card with repair and task-detail actions | `packages/ui/src/WorkspaceApp.tsx` | Full smoke `packaged_failure_repair_pass` | Implemented, dedicated capture gap |
| One user task equals one count | Background indexing could read as a running agent task; terminal work could race old status | Header separates background work; phase persistence is ordered; terminal workflow cannot be revived by later plan bookkeeping | `apps/desktop/src/close-lifecycle.ts`, `packages/server/src/workflow-service.ts`, `packages/ui/src/workspace-sse.ts` | `03-workflow-completed.png` | Verified |
| Persistent integrated composer | R2 corrected clipping but R3 required product continuity | Context chips, Agent/Chat control, model selector, attachment/context controls and send affordance stay together | `packages/ui/src/Composer.tsx`, `workspace.css` | `01-authenticated-zero-state.png`, `03-workflow-completed.png` | Verified |
| Settings as product control center | Needed packaged validation | Account, models, agents, safety, providers, about, search and close behavior are smoke-covered | `apps/desktop/src/renderer/settings/` | `05`–`13` captures | Verified |

The references informed interaction hierarchy and information density only. CodeForge retains its own brand, ForgeAuto/ForgeZero/ForgeVerify language, controls, and visual system; no competitor branding, assets, or pixel layout was copied.

## Visual review result

The R3 packaged terminal-task capture was reviewed after the final UI reconciliation. It shows the same task as `Idle` in the header, `Completed · 11/11 stages` in progress, and `Completed · now` in the sidebar. This replaces the earlier contradictory terminal/Verifying state.

## Remaining capture work

The required 20-state manifest is not yet complete. The R3 directory contains the actual smoke captures listed below; it does not fabricate copies for unexercised states. Dedicated packaged captures for expanded tools/commands, live approval, active ForgeVerify failure, diff review, waiting provider, short-height home, and interrupt/recover remain certification blockers.
