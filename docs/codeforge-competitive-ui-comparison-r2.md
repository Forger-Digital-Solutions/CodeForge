# CodeForge competitive UI comparison — R2

This matrix records design observations from the five screenshots supplied with the R2 request.
It describes them without embedding or redistributing their proprietary imagery. The aim is to
translate useful interaction principles into CodeForge's own restrained visual system, not to
replicate another product.

| Reference | Observed UX principle | Previous CodeForge behavior | CodeForge-specific implementation | Priority | Implemented | Visual verification |
| --- | --- | --- | --- | --- | --- | --- |
| Screenshot 1 — split desktop task views | A compact history rail, readable thread, and persistent composer make complex work feel continuous. | Task history and the work surface existed, but the idle screen foregrounded generic overview/favorites over the selected repository. | Added a compact selected-workspace brief using actual Git/index facts; retained the existing event-sourced thread and persistent context-aware composer. | P0 | Yes | Source render + focused UI tests; packaged visual check pending R2 package. |
| Screenshot 2 — dark active agent view | Scannable, chronological tool rows make an active task legible without a separate terminal. | CodeForge already rendered expandable event-sourced tool rows, but title and history safeguards were not explicit at the navigation boundary. | Preserved inline command/tool detail and added title sanitation plus one-session-one-row deduplication to the history boundary. | P0 | Yes | Focused UI tests; packaged visual check pending. |
| Screenshot 3 — execution transcript | Long command output belongs behind a compact summary; the user should see conclusions and changed files first. | CodeForge already offers expandable activity rows and diff-aware file events. | No visual clone adopted. Existing inline activity/command structure remains the reference-aligned CodeForge implementation. | P1 | Existing | Reassess against a live task before final certification. |
| Screenshot 4 — empty workspace/dashboard | A home surface should establish identity and workspace context immediately, but large decorative voids do not help start work. | Centered idle state could overemphasize activity metrics and consume height. | Repository brief now appears before secondary activity; a short-height rule compacts home content while preserving the composer. | P0 | Yes | Focused UI tests + forced typecheck; packaged visual check pending. |
| Screenshot 5 — workspace landing/composer | Repo-aware entry and a strong bottom composer help a product feel like an engineering environment rather than a generic chat. | Composer was persistent and context-aware but the home state did not expose working-tree/index status. | Workspace brief exposes repository, branch/worktree, plain-language Git state, and real index counts. No copied mascots, branding, heatmaps, or layout. | P0 | Yes | Focused UI tests + forced typecheck; packaged visual check pending. |

## Decisions

- Adopt: compact hierarchy, explicit non-color task states, repository-first idle context,
  expandable internal commands, and persistent composer priority.
- Do not adopt: competitor logos/mascots, wording, color systems, proprietary screen hierarchy,
  invented productivity metrics, or large decorative analytics panels.
- Keep CodeForge-specific: ForgeZero eligibility, ForgeAuto route state, 8-Bit presentation,
  repository intelligence, approval ownership, worktree context, and event-sourced recovery.

## Remaining visual gates

The final package must be inspected at normal and short Windows heights for the idle workspace,
history, active task, expanded command, approval, verification, recovery, completion, route/model
surface, settings, account, and first-paint composer. This matrix is not certification evidence on
its own.
