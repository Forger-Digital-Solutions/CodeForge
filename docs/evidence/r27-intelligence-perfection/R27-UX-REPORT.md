# R27 Desktop UX Report

Status: `R27_DESKTOP_UX_DETERMINISTICALLY_PROVEN_CURRENT_PACKAGE_NOT_PROVEN`

## What the source-level UX proves

The workspace has a single lifecycle projection for its task header, sidebar, composer, and
terminal/failure presentation. It groups routine successful activity while preserving failed work,
keeps the composer available for new prompts or steering, and presents current workflow state,
approvals, changed files, command status/output, subagents, verification, repair, and the final
completion decision from durable data.

Approvals use an ordered server-authoritative queue. A reload restores only requests the backend
still considers pending, and resolving one cannot hide another. The inspector calls its command
history panel “Commands”; it does not claim an interactive terminal it does not provide.

## Validation

All 24 UI suites (324 tests) and all 40 desktop suites (344 tests) pass. The UI and desktop
TypeScript projects typecheck. Coverage includes activity grouping, composer behavior, canonical
run lifecycle, approval recovery, workflow progress, changed-file/verification projections,
subagent hierarchy, final results, desktop bridges, package security gates, and runtime ownership.

## Boundary

The available package was built on 2026-09-21 and is not evidence for the current source state, so
it was not launched. Browser work has only timeline/tool visibility, not a dedicated live-browser
panel. The Commands panel shows executed command history and output, not an interactive PTY.
No actual packaged-window, assistive-technology, responsive-layout, or user-study validation was
performed.
