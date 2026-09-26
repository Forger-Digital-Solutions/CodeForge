# R36 — Application shell

## Left navigation

- "Files" view wired to the real `FileExplorer` (was a dead stub). `Navigation` accepts
  `workspacePath` + `apiBase`.
- Task rows carry session status incl. parked/waiting states; titles truncate cleanly.

## Header

- Task title truncation, live status pill, Stop control — verified live (`r36-real-demo-3.png`
  shows "Fix the failing calc tests… · Verifying 3:38 · Stop").

## Icons

`emoji-assets.ts` / `activity-icons.tsx`: added kinds for command/steer/subagent/notice/browser
and moved nav/file icons toward the monochrome direction (de-emoji'd FileExplorer icons).

## Inspector chrome

Resizable via drag handle; tabs: Changes, Run, Commands, Browser, Files, Evidence, Overview.
