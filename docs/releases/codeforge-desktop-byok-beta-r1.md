# CodeForge Desktop BYOK Beta R1

CodeForge Desktop BYOK Beta R1 is a Windows x64 technical beta candidate for
user-owned provider credentials. It is not a hosted-cloud commercial launch,
does not enable paid inference or billing, and is not legal or attorney
certification.

## What is included

- Windows x64 NSIS installer and portable executable targets.
- User-owned provider credential storage through the desktop secure-storage
  boundary.
- Free-model eligibility enforced by ForgeZero; provider availability and
  free status can change.
- Local project work and host-command execution through the user's operating
  system permissions.

## Important limitations

- No commercial subscriptions, Stripe activation, hosted paid routing, or
  shared provider keys are part of this beta.
- AI output requires user review. Provider uptime, quotas, eligibility, and
  terms may change.
- Commands run with the user's host permissions; CodeForge does not claim that
  host execution is fully sandboxed.
- Windows artifacts may remain unsigned until a signing identity and release
  authorization are approved.
- Root license-owner authorization and the minimum-age product policy are
  business decisions and must not be inferred from this technical candidate.

## Provider and privacy expectations

BYOK requests go to the provider selected by the user. Review each provider's
current terms, privacy policy, retention, and training practices before use.
CodeForge does not claim that all providers or all free tiers have the same
data practices. Do not enter credentials or source code that you are not
authorized to send to the selected provider.

## Supported scope

The beta is intended for Windows 10/11 x64 testing. Cloud-specific features
may be unavailable when the service is offline; local and permitted BYOK
features should fail cleanly rather than silently enabling a paid route.

## Feedback

Use the repository's approved support route when one is provided with the
distribution. No new support address is invented by this document.
