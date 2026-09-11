# CodeForge Desktop BYOK Beta R1 — Counsel Closing Binder

**Handoff status:** `NOT_READY_FOR_ATTORNEY_SIGNOFF` until the exact Windows
candidate has packaged security, runtime-license, hash, and visual evidence.
This binder is a factual handoff, not legal advice or attorney approval.

## Review target

The target is the Windows x64 CodeForge Desktop BYOK Beta. Users supply their
own provider credentials; CodeForge does not enable subscriptions, Stripe,
hosted shared-key routing, or public distribution in this milestone.

CodeForge can read and write selected project files and can execute commands
with the user's operating-system permissions. The application uses Electron
renderer sandboxing/context isolation and encrypted credential storage when
available, but host command execution is not represented as fully sandboxed.

## Data boundaries

Local settings include recent projects, onboarding state, age-policy
acknowledgement, and encrypted provider credentials. Provider-bound prompts,
source context, and outputs leave the device only when a user-configured
provider is used. Cloud authentication and GitHub behavior are separate
features and are not a substitute for BYOK consent.

## Current evidence

- Source/build/test evidence: `docs/releases/codeforge-desktop-byok-beta-r1-certification-report.md`
- Beta scope: `docs/releases/codeforge-desktop-byok-beta-r1.md`
- Packaged evidence location: `docs/releases/evidence/desktop-byok-beta-r1/`
- Security architecture: `SECURITY.md`
- Provider interface: `PROVIDERS.md`

The current local commit is not present on the GitHub remote, so no exact-HEAD
Windows package was triggered or represented as existing.

## Decisions and questions

The owner has authorized an **18+ acknowledgement for this Desktop BYOK Beta
only**. The MIT copyright holder remains blank and requires authorization.
Counsel should address provider terms/data use, privacy and retention,
host-command disclosures, warranty/liability, trademark posture, and
distribution/signing posture.
