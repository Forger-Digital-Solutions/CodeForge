# CodeForge R7U competitive desktop UI scorecard

## Scope and scoring method

Scores are 1–10 and measure daily engineering usefulness and visual maturity, not backend
capability. “Before” is the R7R source/UI audit immediately before this R7U change; “after” is
the freshly packaged `release-r7u-final5` evidence run. Scores are intentionally conservative:
unexercised live-provider and multi-window scenarios cannot earn a high score.

| Area | Before | After | Evidence / reason |
|---|---:|---:|---|
| Information hierarchy | 6 | 7 | Project, task, runtime status, composer, and inspector are visible at a glance; top chrome is still busy at 1366-scale. |
| Density | 6 | 7 | Compact three-pane frame and one-line activity remain strong; recovery/approval still consumes substantial vertical space by design. |
| Readability | 6 | 7 | Dark neutral layers and restrained semantic color read well in packaged captures; some secondary metadata remains too faint. |
| Session navigation | 5 | 7 | Task rows now convey title, running/terminal status, recency, truncation, hover, and active state. |
| Active-task visibility | 7 | 7 | Phase/status, activity/evidence, approval, and completion are distinct; phase progress is authoritative rather than percentage theater. |
| Tool activity | 7 | 7 | Existing compact log remains legible in the completed run; no broad component rewrite was needed. |
| Composer | 6 | 7 | Dense input, explicit Agent/Chat mode, model trigger, send affordance, and keyboard hints are packaged and visible. |
| Model picker | 4 | 7 | Structured sections, locked-state clarity, immediate catalog/provider filtering, visible count, focus, Escape close, and empty result state. |
| Approval UX | 7 | 7 | Clear scope, risk cue, explicit allow/session/deny choices; captured recovery state confirms it remains actionable. |
| Diff/change visibility | 5 | 5 | Inspector presents a changed-files summary, but a richer compact diff/review workflow remains future work. |
| Completion UX | 6 | 7 | Completion-gate evidence and compact workflow status are visible in the packaged thread. |
| Error/recovery UX | 6 | 7 | Recovery no-replay state and a fresh task’s fail-closed blocked result were exercised from a packaged binary. |
| Visual consistency | 6 | 7 | Narrow neutral palette, consistent compact radius, and restrained blue/green/orange semantics. |
| Responsiveness | 5 | 5 | CSS breakpoints exist, but R7U did not capture the required multiple native window sizes. |
| Developer usefulness | 7 | 7 | Verified workspace index, approval, evidence, restart recovery, and composer are integrated; live catalog/task stress remains open. |

## Competitive UX matrix

Legend: **strong** = first-party evidence identifies the pattern as a product strength; **adopted**
= CodeForge packaged evidence; **reference** = used as a design principle, not a claim of visual
pixel comparison from a local private window.

| Area | CodeForge after | Claude | Codex | Devin | OpenCode | Zed | Best pattern retained |
|---|---|---|---|---|---|---|---|
| Project and session hierarchy | adopted: project + compact task list | reference: concise continuation | strong: projects/threads | strong: repo/session selector | strong: tabs/sessions | strong: threads | Explicit project context plus task-level history |
| Active work status | adopted: phase/evidence/approval | reference: concise task control | strong: supervised task progress | strong: unified progress | reference: dense live interface | strong: stream state | State close to the work, not a dashboard |
| Tool visibility | adopted: compact engineering log | reference | strong: changed work/review | strong: session tools | strong: direct developer controls | strong: agent panel | One-line default with expandable detail |
| Composer | adopted: mode + model + keys | reference | strong: task-oriented composer | strong: Ask/Agent modes | strong: prompt with file context | strong: agent thread input | Keep complex request entry compact |
| Model access | adopted: filterable structured overlay | reference | reference | reference | strong: provider/model breadth | reference | Search first; availability truthfully labeled |
| Approval/recovery | adopted: scoped approval and fail-closed recovery | reference | reference | reference | reference | reference | Make user action and safety reason explicit |

## Design decisions

**Keep:** CodeForge’s three-pane engineering frame, compact activity, ForgeZero visibility,
ForgeVerify evidence, recovery semantics, and restrained monochrome identity.

**Improve:** task-list information density, model catalog scanability, composer containment,
authoritative workflow status, and packaged visual evidence.

**Replace:** the flat unfilterable catalog behavior and misleading raw workflow percent in the
header.

**Defer:** live 400+ catalog virtualization/keyboard roving focus, multi-size screenshot matrix,
rich diffs/review, and five real provider-driven task captures.

## Scorecard verdict

`CODEFORGE_R7U_COMPETITIVE_DESKTOP_UI_BLOCKED`

The implemented UI delta and final5 packaged proof are real. The milestone is blocked, not failed,
because the required local competitor-window visuals, live 400+ catalog exercise, five realistic
provider tasks, and native multi-window-size evidence remain unavailable or unexercised.
