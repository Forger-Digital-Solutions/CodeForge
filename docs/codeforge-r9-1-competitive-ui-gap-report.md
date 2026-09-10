# CodeForge R9.1 Competitive UI Gap Report

**Date:** 2026-09-10
**Milestone:** R9.1 — Daily-Driver UI Presentation & Workspace Remediation

## Purpose

This report separates features **implemented in R9.1** from **future product gaps** identified during competitive analysis of Qoder, Codex, Devin, ZCode, OpenCode, Claude Code, and Cline. R9.1 scope was strictly presentation layer remediation — not feature parity with every competitor capability.

---

## ✅ IMPLEMENTED IN R9.1

### Shell & Layout
- [x] Qoder-style workspace shell (Workspaces/Tasks/Files sections)
- [x] Clean header with workspace name + branch
- [x] Toolbar controls (☰ sidebar, 🔍 inspector) with keyboard shortcuts
- [x] Right inspector default closed, opens on demand
- [x] Coherent three-column layout grid

### Composer
- [x] `+` attachment menu (file, image, folder, paste screenshot, repo context)
- [x] `@` context picker for files/symbols/recent
- [x] Clipboard image paste (Ctrl+V)
- [x] Drag-and-drop file support
- [x] Attachment preview chips with remove
- [x] Model picker integrated in composer toolbar
- [x] Execution mode toggle (Agent/Chat)

### Model Selection
- [x] Structured categories: ★ Favorites, RECOMMENDED, FREE, GEMS, OPENROUTER, ANTHROPIC, OPENAI, etc.
- [x] Human-readable names (not raw provider IDs)
- [x] Star-to-favorite persistence per user
- [x] ForgeAuto/Free as primary default with zero-cost routing badge

### Empty State
- [x] Premium centered invitation: "What are we forging?"
- [x] Favorite models quick-start row
- [x] Suggested prompts
- [x] No fake analytics/heatmap dashboards

### Conversation & Chat
- [x] Document-like assistant prose (reasoning collapsed, code blocks, inline code)
- [x] Plan strip: "2 of 4 steps" with expandable steps
- [x] Grouped tool activity: "[8-Bit Read] Read 5 files ▸"
- [x] Presentation normalization — raw protocol never renders
- [x] Private reasoning never leaks (`stripToolProtocol`, `parseAssistantContent`)
- [x] User messages show only actual user input (no generated system prompts)

### Inspector & Review
- [x] Changes tab: interactive file list with +/− stats → diff viewer
- [x] Run tab: command history with expandable output
- [x] Evidence tab: checkpoints + verification conclusions
- [x] Files tab: repository tree (stubbed for backend integration)
- [x] Overview tab: task summary, agent/model/branch, file/test counts

### Navigation
- [x] Tasks/Files view toggle
- [x] Session status icons: ● Running, ✓ Completed, ✕ Failed, ⏹ Cancelled, ? Needs Input, ⏳ Awaiting Approval
- [x] Git status in file tree: M modified, U untracked, S staged
- [x] Relative time grouping: Today, Yesterday, Previous 7 Days, Older

### Command Center
- [x] Ctrl+K opens command palette with 20+ actions
- [x] Searchable, keyboard navigable
- [x] Includes: New Task, Open Workspace, Search Sessions/Files, Attach File, Toggle Panels, Model Picker, Usage & Billing, Repository Intelligence, Permissions, MCP/Plugins, Settings, Clear Context, Approve/Deny All, Stop Agent

### Header & Settings
- [x] Repository Intelligence popover (status, counts, rebuild, disable, settings link)
- [x] ForgeZero popover (trust status details, not permanent pill)
- [x] Compact account avatar (opens Usage & Billing modal)
- [x] Settings reorganization: Account, Usage & Billing, Models & Providers, Permissions & Approvals, Repository Intelligence, Integrations/MCP, Appearance, Advanced

### Keyboard Shortcuts
- [x] Ctrl+N = New Task
- [x] Ctrl+K = Command Center
- [x] Ctrl+B = Toggle Sidebar
- [x] Ctrl+Alt+B = Toggle Inspector
- [x] Ctrl+M = Model Picker (focus)
- [x] Ctrl+P = Search Files
- [x] Ctrl+Shift+A = Attach File
- [x] Ctrl+L = Clear Context
- [x] Esc = Stop/Close popups
- [x] Enter = Send, Shift+Enter = Newline

---

## 📋 FUTURE PRODUCT GAPS (Post-R9.1)

### Visual Verification & Browser
- [ ] Built-in browser/preview tab (ZCode, Devin, Qoder)
- [ ] App/window screenshot capture (Ctrl+Shift+S)
- [ ] Visual regression testing integration
- [ ] Live preview URLs for web projects

### Rich Artifacts & Annotations
- [ ] Inline artifact rendering (HTML, SVG, notebooks, PDFs)
- [ ] Interactive diff annotations (comments on specific lines)
- [ ] Notebook-style cells for data/ML tasks
- [ ] Terminal PTY integration (not just command history)

### Multi-Agent & Orchestration
- [ ] Multi-agent visual orchestration (Devin-style agent grid)
- [ ] Parallel workstream visualization
- [ ] Agent handoff visualization
- [ ] Remote mobile supervision / companion app

### Advanced Workflow
- [ ] Scheduled agent tasks (cron-style)
- [ ] Goal/Success criteria tracking (Codex-style)
- [ ] Checkpoint/revert timeline with visual snapshots
- [ ] Activity grouping (collapse repetitive reads/searches/commands)
- [ ] Task timeline strip (●────●────○────○ navigation)

### Intelligence & Search
- [ ] Semantic code search in sidebar
- [ ] Symbol navigation (go to definition, find references)
- [ ] Repository-wide grep in command palette
- [ ] AI-powered code explanations on hover

### Accessibility & Polish
- [ ] Full ARIA compliance audit
- [ ] Screen reader optimization for chat/activity feed
- [ ] Reduced motion compliance
- [ ] High contrast theme
- [ ] Focus trap management in modals

### Performance
- [ ] Virtualized conversation rendering (10k+ messages)
- [ ] Lazy-loaded inspector tabs
- [ ] Incremental diff computation
- [ ] Web Worker for heavy parsing

### Settings & Configuration
- [ ] Keyboard shortcut customization UI
- [ ] Theme builder (custom colors)
- [ ] Provider-specific model configuration
- [ ] Approval rules editor (allow/ask/deny per tool)

---

## Competitor Principle Verification

| Principle | Qoder | Codex | Devin | ZCode | OpenCode | CodeForge R9.1 |
|-----------|-------|-------|-------|-------|----------|----------------|
| Calm, task-centric shell | ✅ | | | ✅ | | ✅ |
| Powerful composer | ✅ | | ✅ | ✅ | | ✅ |
| Files/workspace integration | ✅ | | ✅ | ✅ | | ✅ |
| Readable conversation | | ✅ | | | | ✅ |
| Reviewable changes | | ✅ | ✅ | | | ✅ |
| Inspectability on demand | | | ✅ | | | ✅ |
| Quick context attachment | | | ✅ | ✅ | | ✅ |
| Model availability semantics | | | | | ✅ | ✅ |
| Granular permissions | | | | | ✅ | Partial |
| Checkpoints/revert | | | | | | Partial |
| Plan/act supervision | | | ✅ | | ✅ | ✅ |
| Drag/drop context | | ✅ | | ✅ | | ✅ |
| Zero-cost authority | | | | | | ✅ |

---

## Notes

- R9.1 deliberately **did not** implement backend-heavy features (browser, PTY, multi-agent UI) to maintain milestone focus on presentation layer
- All future gaps are documented for prioritization in R10+
- CodeForge-native identity preserved: ForgeAuto/Free, 8-Bit, ForgeZero, durable continuation, steering, approvals
- No paid model fallback, no local LLM inference — ForgeZero remains fail-closed