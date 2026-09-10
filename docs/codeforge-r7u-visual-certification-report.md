# CodeForge R7U — competitive desktop UI visual certification

## Verdict

\`CODEFORGE_R7U_COMPETITIVE_DESKTOP_UI_BLOCKED\`

R7U delivered and packaged a focused desktop UX rework without destabilizing runtime authority.
The final5 package passes first paint, controlled repair, catalog interaction, renderer reload,
credential encryption, interruption, and no-replay recovery. Full certification is blocked by
evidence gaps that this pass could not truthfully close: protected local competitor-window pixels,
a live 400+ model catalog, five realistic provider-driven tasks, and the required native
multi-size capture matrix.

## What was inspected

### Local competitor discovery

Claude, Codex/ChatGPT, Devin, OpenCode, and Z Code process trees were confirmed active on the
host. Connector application inventory, PID-correlated Win32 window enumeration, and full-desktop
capture were all attempted. The connector exposed no native apps; top-level window enumeration
returned no visible windows for the target PIDs; and desktop capture returned an invalid black
frame. No private user window was activated, sent input, closed, or otherwise modified.

The detailed process record, capture methods, official fallback sources, and adopted principles
are in [the reference index](certification/r7u/reference/index.md).

### First-party fallback references

- [OpenAI Codex app](https://openai.com/index/introducing-the-codex-app/): projects, threads,
  multi-agent supervision, progress, and review hierarchy.
- [Devin session tools](https://docs.devin.ai/work-with-devin/devin-session-tools): a unified
  view of shell/IDE/browser activity and outputs.
- [OpenCode Desktop](https://dev.opencode.ai/download): session tabs in a desktop client and a
  developer-first model/provider surface.
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel): thread/agent selection and streamed
  tool state in a compact editor-adjacent surface.
- [Claude Desktop](https://support.anthropic.com/en/articles/10065433-installing-claude-for-desktop):
  desktop integration and a clear extension/security boundary.

These were used for product principles rather than copied layout, assets, or trade dress.

## Weaknesses found and changes made

| Area | Finding | R7U change |
|---|---|---|
| Task navigation | A title-only row made old, active, and recent work hard to distinguish. | Task rows now carry running/terminal status and compact relative recency while retaining truncation and active/hover state. |
| Workflow status | A raw percent can imply measurable progress that the runtime does not have. | Header now reports the authoritative phase only. |
| Model catalog | A large catalog had no immediate filter and would not scale to the anticipated real provider list. | Added immediate search across current section, id, display name, description, and tier; count, focus, Escape close, and a clear no-result state. Locked models remain non-routable. |
| Composer/popup density | The functional composer and picker needed a tighter, more consistent container. | Tightened padding/radius, bounded the dropdown to viewport/scroll space, and retained explicit Agent/Chat and keyboard hints. |
| Visual certification | Package smoke proved behavior but did not preserve pixel evidence. | Added opt-in \`webContents.capturePage()\` evidence captures to the packaged smoke path. |

The rework is deliberately presentation-led. It does not route a model, change ForgeZero policy,
duplicate runtime state, relax the completion gate, or alter approval authority.

## Packaged final5 evidence

Artifact root: \`apps/desktop/release-r7u-final5\`.

| Artifact | SHA-256 |
|---|---|
| \`CodeForge-Portable.exe\` | \`305A8BCCDBE2EAD19D7D6AF38E46C40D1A5541C795D44738A938E672B7F021CC\` |
| \`CodeForge-Setup-0.2.0.exe\` | \`504E606CB6E240C04985A7F3D496969D223F2F968506BA5CBE4E03B6B103F593\` |
| \`win-unpacked/CodeForge.exe\` | \`45AFE91CB66C6D0AAC8680513C6E44EF52FFC67D2D5DBF15577F34FDB4BFE22A\` |
| \`win-unpacked/resources/app.asar\` | \`555E79EEA33B56AE47CB5A2DA0255485374CF0DB7552CFF872A54E065C2E76F3\` |

The final5 exact packaged payload was launched with \`app.isPackaged === true\`. Full, controlled
interrupt, and recovery smoke passed. Full smoke reached onboarding/provider setup, project
selection, a 258-file/259-symbol local structural index, workspace escape refusal, approval,
bounded repair, verification, completion, and five renderer reloads. Recovery smoke confirmed
no approval replay, \`replan_required\`, encrypted credential restart/decryption, corrupt credential
fail-closed behavior, and a fresh no-op task ending \`blocked\` with completion-gate evidence.

### Pixel evidence captured from that payload

All evidence is rendered by the packaged final5 executable; no development screenshot is used as
certification proof.

| State | Evidence | Observation |
|---|---|---|
| Onboarding | [01-onboarding.png](../apps/desktop/release-r7u-final5/r7u-captures/01-onboarding.png) | Clear first-run hierarchy and provider entry point. |
| New workspace | [02-workspace-ready.png](../apps/desktop/release-r7u-final5/r7u-captures/02-workspace-ready.png) | Dense three-pane project/task/composer layout. |
| Model catalog | [02a-model-catalog.png](../apps/desktop/release-r7u-final5/r7u-captures/02a-model-catalog.png) | Structured ForgeAuto, verified-free, and unavailable sections. |
| Model filter | [02b-model-filter.png](../apps/desktop/release-r7u-final5/r7u-captures/02b-model-filter.png) | “auto” reduces six entries to one immediately. |
| Completed repair | [03-workflow-completed.png](../apps/desktop/release-r7u-final5/r7u-captures/03-workflow-completed.png) | Approval, evidence, completed workflow state, and session metadata coexist without a dashboard. |
| Restart recovery | [04-recovery.png](../apps/desktop/release-r7u-final5/r7u-captures/04-recovery.png) | Recovery is explicit; approval is contained and a completed prior task stays visible. |

## Validation

- Focused desktop/UI suite: **8 files, 47 tests passed** before final packaging.
- Final compile confirmation after the evidence hook: desktop main TypeScript passed; focused
  selector/navigation/desktop suite: **4 files, 19 tests passed**.
- Production renderer build passed (Vite reports its known ~517 KB minified-chunk advisory).
- \`git diff --check\` passed.
- Package build passed; no signing identity was configured, so electron-builder correctly skipped
  code signing.
- The full, interrupt, and recovery packaged smoke commands all passed against final5.

The broad repository typecheck remains outside this evidence because inherited dirty-tree
protocol/session desktop-worker additions already prevent it from passing. No broad success is
claimed.

## Remaining R7U work to reach certification

1. Capture actual local competitor windows through a surface that can expose them, or record a
   secure approved screen capture that does not reveal private content.
2. Exercise the live provider catalog (historically ~431 models / ~21 verified free) through the
   picker, including 400+-row performance, provider/capability aliases, keyboard traversal, and
   persistence.
3. Capture five real provider-driven task categories: localized fix, multi-file feature,
   correction, large-context answer, and change/verify/summary.
4. Capture compact, 1366×768, 1920×1080, maximized, and narrow supported window states.
5. Expand change/diff review visibility once the underlying source-of-truth view is ready.

R7 daily-driver certification remains blocked on its existing live-auth, live-catalog,
realistic-task, collaboration/reconnect, and benchmark gates. R7U improves the packaged desktop
experience and its evidence harness; it does not claim those broader gates are closed.
