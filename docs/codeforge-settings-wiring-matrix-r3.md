# CodeForge R3 settings wiring matrix

| Surface | Authority | Runtime effect | Packaged evidence |
| --- | --- | --- | --- |
| General | Validated desktop settings store | Appearance and interaction preferences are rendered by the shell | `05-settings-general.png` |
| Account | Desktop cloud-account IPC | Uses real account view; fixture identity is not displayed as a normal user | `05a-account-menu.png`, `06-settings-profile.png` |
| Models | `/api/models` plus validated settings | Catalog refresh, default-model persistence, ForgeZero eligibility | `07-settings-models.png`, `02a-model-catalog.png` |
| Agents | Runtime status IPC | Presents running state without inventing a task count | `08-settings-agents.png` |
| Safety | Desktop settings and ForgeZero | Approval and safe-close policy remain authoritative | `09-settings-safety.png`, full smoke trust-boundary checks |
| Providers | Provider health/catalog API | Only verified free routes remain eligible for ForgeAuto | `10-settings-providers.png` |
| Verification | Workflow/ForgeVerify event and work-item state | Completion remains gated by runtime evidence, never Settings UI | workflow smoke and completed-task capture |
| Search / close behavior | Settings shell state | Search and safe-close preference have dedicated packaged checks | `12-settings-search.png`, `13-settings-close-behavior.png` |

The R3 full packaged smoke passed all of the listed Settings screens. It also confirmed the renderer lacks a raw credential API, control-plane bearer remains withheld, forged IPC/origin/bearer attempts are rejected, and encrypted credential storage round-trips.
