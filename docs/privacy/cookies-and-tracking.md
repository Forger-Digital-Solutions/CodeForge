# Cookies, Local Storage, and Tracking

Audit of everything CodeForge stores in a browser or renderer and every third-party script or
SDK it loads (Phase 44). Result: **one strictly necessary cookie, no tracking, no analytics, no
advertising, no consent banner needed for non-essential cookies because there are none.**

## Cookies

| Cookie | Set by | Purpose | Attributes | Lifetime | Category |
| --- | --- | --- | --- | --- | --- |
| `__Host-codeforge-session` (`codeforge-session` on plain-http development) | CodeForge Cloud API after the FDS website GitHub sign-in | Keeps you signed in to the website account view | `HttpOnly; Secure; SameSite=Lax; Path=/`; host-only (`__Host-` prefix) | 7 days, or until logout | Strictly necessary (authentication) |

No other cookie is set by CodeForge. The desktop app does not use cookies for CodeForge Cloud
(it uses sealed bearer tokens held by the main process). Third parties reached during sign-in
(GitHub) and payment (Stripe-hosted pages) set their own cookies on their own domains under their
own policies.

## Desktop renderer `localStorage` (UI preferences only)

| Key | Content | Purpose |
| --- | --- | --- |
| `codeforge:active-session-id` | Local task session id | Restore the open task after a reload |
| `codeforge:execution-mode` | Execution mode enum | Remember the selected mode |
| `codeforge:sidebar-collapsed` | `true`/`false` | UI layout |
| `codeforge:model-favorites` | Model ids | Favorites list |
| `codeforge:user-intent-hold-policy` | Policy enum | Hold behavior preference |

None of these is an identifier that leaves the device, and none contains a credential (the
renderer never possesses one). `sessionStorage` and IndexedDB are not used.

## Third-party scripts, SDKs, pixels

| Category | Present? | Evidence |
| --- | --- | --- |
| Analytics (Google Analytics, Mixpanel, Segment, PostHog, …) | **No** | Repository grep in R1: no SDK dependency, no script tag; the renderer CSP allows scripts from `'self'` only |
| Advertising / tracking pixels | **No** | same |
| Session replay (FullStory, LogRocket, Hotjar, …) | **No** | same |
| Crash reporting (Sentry, Bugsnag, …) | **No** | no dependency; `packages/telemetry` is an unused stub |
| Product telemetry to CodeForge servers | **No** | Settings › Data & Privacy states "None collected"; no endpoint exists to receive it |
| Remote fonts/CDN scripts in the desktop | **No** | CSP `default-src 'self'`; the only remote resource is GitHub avatars (`img-src https://avatars.githubusercontent.com`) |

## Consent

Because the only cookie is strictly necessary for a service the user explicitly requests
(signing in), no cookie-consent banner is displayed and none is required for it. If analytics or
any non-essential storage is ever added, this document, the privacy policy, and the consent
mechanism must change first (REQUIRES LEGAL REVIEW at that time).

## How to verify

- `grep -rn "localStorage" apps/desktop/src/renderer packages/ui/src` lists the keys above.
- `grep -rni "sentry\|analytics\|posthog\|mixpanel\|segment\|gtag" apps packages --include=*.ts --include=*.tsx --include=*.html` returns only the Data & Privacy settings copy stating none is collected.
- `apps/cloud-api/src/server.ts` `browserSessionCookie()` is the only `Set-Cookie` writer.
