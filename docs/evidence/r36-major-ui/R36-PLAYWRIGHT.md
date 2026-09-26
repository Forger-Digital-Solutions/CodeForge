# R36 — Playwright visual verification

Harness: `apps/web` Vite dev server, `/qa.html?scenario=<name>` — real `@codeforge/ui`
components with fixture events (not mocks).

## Scenarios captured

| Screenshot | Scenario | Shows |
|---|---|---|
| `screenshots/r36-live-run.png` | `live-run` | mixed group, steer row, live command cards, subagents, capacity strip, browser row |
| `screenshots/r36-live-run-2.png` | `live-run` | Inspector Commands: transcript, cwd, durations |
| `screenshots/r36-browser-tab.png` | `browser-tab` | browser action log |
| `screenshots/r36-changes.png` | `changes-diff` | change rows with +/− stats |
| `screenshots/r36-changes-expanded.png` | `changes-diff` | inline diff expansion |
| `screenshots/r36-capacity-parked.png` | `capacity-parked` | sidebar "Waiting for free capacity" |
| `screenshots/r36-real-app.png` | live app | empty state, real chrome |
| `screenshots/r36-real-demo-3.png` | live app | real send → running turn, header status, Stop, steer composer |

## Live verification

`forge serve --port 3210` (demo runtime) + vite at 5175 with proxy auth. Sent a real task through
the composer: session created, turn started, status/plan/verification events streamed, header and
Inspector updated honestly.

## Console findings

- `favicon.ico` 404 on the Vite harness — benign harness-only issue, not shipped UI.

## Known live-demo quirk (backend, not UI)

Under `forge serve` demo mode, `runDemoRuntime`'s scripted feed events were observed broadcasting
under session `"default"` for sends without a `sessionId`, while the UI-created session received
only real turn-machinery events (status/plan/verification) and no feed rows. This is a demo-mode
server quirk; R36 consumes whatever contract events arrive and was verified against the full
vocabulary via the QA harness. Worth a follow-up ticket outside this campaign.
