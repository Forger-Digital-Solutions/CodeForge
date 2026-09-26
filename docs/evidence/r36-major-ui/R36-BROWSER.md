# R36 — Browser activity surface

- Feed: `browser_*` tool events render as `browser` kind rows — "Browse <url>" + result status
  (e.g. `200 OK`) — instead of generic "Activity".
- Inspector: dedicated **Browser** tab lists the projected browser action log for the session.
- Icons: browser iconography in the monochrome set (`activity-icons.tsx`, `emoji-assets.ts`).

Verified visually: `screenshots/r36-browser-tab.png` (QA harness `browser-tab` scenario).
