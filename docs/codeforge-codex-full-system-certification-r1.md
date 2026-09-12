# CodeForge — Codex Full-System Certification R1 (packaged live autonomy closure)

**Verdict: `CODEFORGE_CODEX_FULL_SYSTEM_R1_BLOCKED`** (interim — session ended at the usage limit).

## 2026-09-12 continuation addendum — candidate `8b54f3c`

The resumed pass found and repaired two release-relevant gaps before attempting another live
task. First, Z.AI direct `/models` returns account-available models without pricing; CodeForge
now permits a `FREE_NATIVE` grant only when that authenticated listing is paired with a freshly
fetched 0/0 registry record and Z.AI's explicit policy flag. It never infers this from a bundled
snapshot, model name, or another OpenAI-compatible provider. OpenAI remains hard policy `PAID`
even if an upstream catalog were erroneous. Z.AI's official pricing currently lists
GLM-4.7-Flash, GLM-4.5-Flash and GLM-4.6V-Flash as free; an account/API key is still required to
verify that a particular route is executable.

Second, the real prior live-test profile exposed a failed session containing a persisted
`waiting_for_approval` turn. At server startup a terminal session now settles all non-terminal
owned turns and marks unresolved approval records `Task ended`; it does not replay tools or
attribute a user denial. The final package was launched against that prior profile and the
formerly waiting turn was observed persisted as `failed` with zero pending approvals.

Validation on `8b54f3c`: 15 focused routing/recovery tests passed, full TypeScript build passed,
and packaged FULL, INTERRUPT, RECOVER, and browser-security audit all passed. Final artifacts:
Setup `79904AF069B5B817FDCF92E1682AF1947872DB18D6AF786C2B4B4A145D319C63`, Portable
`DD75DB8F813BB4145465574F62EDCA293FF6776B8BD26BAE3C1B976ACD343D81`, unpacked EXE
`D67C61BAFFF1C1D673F55196A526C772BF8B2EA9DF88EAE8985B8315D4281C44`, app.asar
`989D1A0904254FDCD620F38AFDDA5E4E9F5CF11736F95519A897224E93787A9E`.

The live OpenRouter account was still at its provider-declared daily free-request cap after the
package launch. ForgeZero displayed the exhaustion truthfully and no paid fallback was invoked.
Therefore a fresh completed live task, live repair loop, and live cross-route failover remain
unproven and this certification remains BLOCKED.

Every deterministic gate is green on the final packaged candidate `d0e2e8f`, and a real
zero-priced OpenRouter model drove a multi-turn coding task through the **packaged** app with
tools, steering, approvals and ForgeVerify. What is still unproven on the final package: a live
task reaching a *completed* completion gate, a forced verification failure repaired live,
minimize/Settings/close during live work, and live model failover. Reasons: live run #1 was cut
by the (now fixed) 120 s agent budget at 11/12 tests passing; run #2 hit OpenRouter's
50-request/day free cap. The machine-readable record is `codeforge-codex-full-system-certification-r1.json`.

## Resume state (read this first next session)

- Branch `forger-digital-solutions-forgegreen-certified`, tree clean at **`d0e2e8f`** (runtime
  candidate). `39255c7` was superseded (preload defect); `f46d4fa`/`29893a4` were the prior
  session's preload fixes, superseded again by `4f0499a` (bearer never reaches the renderer).
- Package for `d0e2e8f` is built in `apps/desktop/release/` (hashes in the JSON); audits and
  full/interrupt/recover smoke all PASS on it.
- Live harness (documented in memory `live-packaged-run-harness`): `C:\Users\Daddy_FDS\CodeForge Live\`
  — local dev cloud-api (`scratch-live-cloud-start.mjs`, seeded account), isolated profile with
  encrypted tokens, `scratch-live-launch.mjs` (packaged exe + `--remote-debugging-port=9333`),
  `scratch-live-task.mjs` (send/click/state/events/shot). Scratch scripts are at the repo root,
  git-excluded via `.git/info/exclude`. Target repo `pricing-service` is reset to baseline `deddf33`.
- **Next live run (#3)** after the OpenRouter free cap resets (00:00 UTC): launch `d0e2e8f`,
  open `pricing-service`, send `CodeForge Live/task-prompt.txt`, approve the plan, "Allow for
  Session" on the first edit (now honored), steer twice, minimize/restore and open Settings
  during the run, let ForgeVerify run; if the gate passes first time, run the controlled-failure
  second task; then test close-during-work. Budget ≤ 50 model calls (run #1 used 43 with
  ForgeAuto's `north-mini-code`; pinning `nvidia/nemotron-3-super-120b-a12b:free` via the picker
  is a legitimate product path and should need fewer calls).
- Then: rerun the full suite from the final SHA and capture exact totals (the d0e2e8f run's
  totals line was not captured by the log filter; its 4 failures were the same load-sensitive
  tests that pass in isolation), and replace `docsEvidenceCommit` in the JSON.

## 1–26 (abbreviated; the JSON carries the numbers)

1. **Verdict** — BLOCKED, see above. No fake green.
2. **Resume state** — above.
3. **Preload packaging defect** — root cause: `preload.cjs` ships, `preload.ts` only types it;
   bearer support was TS-only. Resolution goes further than parity: the renderer never holds the
   bearer (main injects it per request from the primary document only); tests + packaged audit +
   9 smoke markers pin it.
4. **Final runtime candidate** — `d0e2e8f`, v0.3.0, clean tree.
5. **Build & tests** — forced tsc PASS; normal build PASS; focused suites (desktop/ui/server/
   workflow/protocol) 148 files / 1,118 tests / 0 failed at `6855434`; full suite at `8b438f0`
   2,296 passed / 4 failed / 36 skipped — all 4 pass in isolation (load timeouts); full suite at
   `d0e2e8f` reproduced the same 4 load-sensitive failures (totals to be re-captured).
6. **Packaged artifacts** — hashes in JSON (installer, portable, unpacked exe, asar, native node).
7. **Packaged smoke** — full / interrupt / recover PASS on `d0e2e8f`.
8. **Security** — origin gate + per-process bearer + primary-window IPC guard; 12/12 external
   adversarial probes PASS; loopback only; no query-string bearer; CORS preflight from foreign
   origin 403; `will-navigate`/`window.open` locked to the app document.
9. **Live model discovery** — 445 catalog / 22 zero-priced / 19 tool-capable; hosted 0 eligible.
10. **Live autonomous task** — run #1 (ForgeAuto → `cohere/north-mini-code:free`): 43 model
    calls, 43 tool calls (17 reads, 19 edits, 1 write, 4 `npm test`), 2 steers reconciled, 22
    approvals, ForgeVerify 3 verifiers, completion refused (verification failed) — truthful.
    Run #2: 429 daily cap → 8-Bit RATE_LIMITED → blocked, no paid fallback. Run #3 pending.
11. **ForgeAuto & 8-Bit** — `router.selection` picks the top ForgeRouter route; 8-Bit receipts
    persisted (INITIAL_SELECTION); failover honestly reported NO_ELIGIBLE_FREE_MODEL when the cap
    is account-wide. Gap: ranking ties without capability scores.
12. **Model picker** — fail-closed: non-eligible rows are `aria-disabled` with reason; non-tool
    $0 routes (Lyria) now locked "No tool calling"; ForgeAuto "Verified $0"; discovery state
    shown while catalogs verify.
13. **Settings** — 14 functional / 13 actions / 8 navigation / 34 informational / 2 intentionally
    unavailable / 3 defects repaired / 0 remaining dead controls (matrix doc).
14. **ForgeZero & approvals** — STRICT live removes all 22 routes (0 eligible) without restart;
    STANDARD restores; plan approval now lists steps; file approvals name the file; "Allow for
    Session" now real (never for high/critical). Deny path covered by tests; live deny not exercised.
15. **Steering** — 2 live steers: intent hold entered/released, queued, reconciled into the turn,
    no duplicate execution.
16. **ForgeVerify & completion authority** — live: verification ran independently of the model's
    claims and the gate refused completion; repair loop previously blocked by the orphan-turn bug
    (fixed, unit-tested); live repair→complete pending.
17. **Repository intelligence** — monorepo 1,162 files / 68,345 symbols, node_modules excluded,
    incremental 14 s, search 99–728 ms; event-loop stall 12.6 s → 2.5 s; index-file race fixed.
18. **Lifecycle & recovery** — restart recovery via smoke (interrupt/recover PASS); close with no
    work now exits deterministically (was an invisible lingering process); live close-during-work pending.
19. **Workspace/UI** — composer no longer clipped (workspace sized to host, not viewport); new
    composer surface (context chips · prompt · attach/mode · model/send); header counts tasks;
    internal turns rendered as system lines; tool rows named and de-duplicated; `@` context wired
    to Repository Intelligence; daily-cap message truthful; offline account keeps identity.
20. **Competitive review** — observed: Codex desktop, ZCode, Devin, Qoder, OpenCode (free picker
    with inline Free badges; project/branch row). Not observable via computer-use here: Cursor,
    Kiro, Zed, VS Code.
21. **AI dev-team readiness** — **B. Autonomous single coding agent** with orchestration
    architecture present (parallel worktrees, missions) but not exercised live in R1.
22. **Windows** — spaces in paths (workspace + profile), PowerShell/npm via run_command, native
    module packaged, tray/close, app data under the profile — verified; WSL not exercised.
23. **macOS** — `MACOS_RUNTIME_VALIDATION_REQUIRES_MACOS_HOST`.
24. **Daily-driver gaps** — MUST FIX: a live task must be shown completing on the final package;
    a no-credit OpenRouter account (50 req/day) is not a daily-driver route — the product needs
    either hosted CodeForge Free capacity or a ≥$10-credit BYOK story; ForgeAuto ranking needs
    capability data (ties). IMPORTANT NEXT: worker-thread indexing (2.5 s residual stalls),
    surface plan steps in the approval card UI natively, "No Git" chip parity, the composer's
    Chat mode value proposition. FUTURE: verification-authority + evidence receipts are a real
    differentiator vs. every tool observed; make them visible in the timeline as first-class.
25. **Competitive matrix** — CodeForge matches the Codex/Claude Code composer pattern now;
    Devin's local/cloud runner choice and Spaces, Codex's PR/scheduled views, Qoder's activity
    calendar and Automations, OpenCode's minimal free-first picker are the observed benchmarks.
26. **Evidence paths** — listed in the JSON.
