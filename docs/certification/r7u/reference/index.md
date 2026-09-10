# R7U competitive-reference index

Observed: 2026-09-09. This index records visual/product reference evidence without copying
competitor artwork or user-window content into the repository.

## Local process discovery and capture attempts

The following active process trees were discovered read-only on the Windows host. Their main-window
titles were blank and the accessible desktop connector exposed no native app surface:

| Product | Example observed executable / PID | Local visual result |
|---|---|---|
| Claude / Claude Code | `Claude.exe` PID 5860; `claude.exe` PID 20072 | Running; no exposed HWND/title |
| Codex / ChatGPT | `ChatGPT.exe` PID 9544; `codex.exe` PID 5296 | Running; no exposed HWND/title |
| Devin | `Devin.exe` PID 5988 | Running; no exposed HWND/title |
| OpenCode | `OpenCode.exe` PID 19216 | Running; no exposed HWND/title |
| Z Code | `ZCode.exe` PID 4308 | Running; no exposed HWND/title |

Methods attempted: connector application inventory, Win32 top-level-window enumeration correlated
to the discovered PIDs, and a full-desktop `CopyFromScreen` capture. The connector inventory had
no native apps, enumeration returned no visible top-level windows for those processes, and the
desktop capture produced an invalid black frame. No activation, input, closing, or inspection of
the user's private app content was performed.

## Current first-party fallback references

| Product | Reference | States/patterns used |
|---|---|---|
| Codex | [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/) and [Codex](https://openai.com/codex/) | Project/thread hierarchy, multi-agent supervision, progress and changed-file review surfaces |
| Claude / Claude Code | [Claude Desktop installation](https://support.anthropic.com/en/articles/10065433-installing-claude-for-desktop) and [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) | Desktop integration boundary; concise session continuation and task control |
| Devin | [First session](https://docs.devin.ai/get-started/first-run) and [Session tools](https://docs.devin.ai/work-with-devin/devin-session-tools) | Ask/Agent separation, repository/session selection, unified progress/tool visibility |
| OpenCode | [Desktop download](https://dev.opencode.ai/download), [product page](https://dev.opencode.ai/), and [TUI docs](https://dev.opencode.ai/docs/tui/) | Tabs/session organization, dense developer-first layout, provider/model access, direct file context |
| Zed | [Agent panel](https://zed.dev/docs/ai/agent-panel) | Thread creation, agent selection, streamed tool state and editor-adjacent density |

## Patterns adopted without copying trade dress

- One dominant engineering thread with compact, secondary inspector context.
- A task navigator that carries active state and recency in the row itself.
- A searchable catalog overlay rather than a long native select control.
- Actionable approvals with a contained risk signal, explicit scope, and a single decision point.
- Evidence-led completion and recovery state rather than decorative progress.

## Explicit limits

This reference record is not a claim that local competitor windows were visually inspected. Local
visual inspection is blocked by the host capture boundary described above. The official pages are
used only for layout and interaction principles; no competitor logos, screenshots, assets, or
proprietary UI were copied into CodeForge.
