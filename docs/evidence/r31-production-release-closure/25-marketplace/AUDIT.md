# R31 Marketplace / Catalog Audit

**Truthful classification: MISSING (not implemented).**

There is no remote extension/plugin marketplace or install catalog in the product. The only
"catalog" in the codebase is `packages/model-registry`'s *provider model* catalog — unrelated.

What exists today (capability management, local):
- Extension discovery: managed dir scan + developer-folder loading (`ExtensionManager`).
- Inspect: manifest (name/version/description/permissions/contributes) via `extensions:list` IPC
  and the Settings → Extensions UI.
- Install: local folder / dev-mode registration (no remote fetch).
- Authorize/manage: enable/disable persisted; per-extension settings + secret store.
- Remove: `uninstall` deactivates, wipes secrets, removes managed files.

What does NOT exist:
- Remote catalog browsing, publisher metadata, ratings, remote install/update channels.
- Marketplace permission/auth preview before install (the manifest permissions ARE surfaced
  locally at inspect time).

Per the R31 addendum, minimum production scope is capability management —
discover/inspect/connect/authorize/manage/disable/remove — all present **locally**. Remote
discovery is a roadmap feature.

Classification: **FUTURE_ROADMAP_NOT_CURRENT_GATE** for remote marketplace;
local capability management is **RELEASE_CERTIFIED** (see 22-plugins).
