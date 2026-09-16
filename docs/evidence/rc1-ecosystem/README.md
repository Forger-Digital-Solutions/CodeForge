# RC1 ecosystem evidence

This directory contains sanitized, no-secret evidence for the RC1 integration campaign.

## Whole-agent runs

- `whole-agent/groq-r1-reproduction.json` — pre-fix reproduction; explorers consumed the parent deadline and the Planner never made a model request.
- `whole-agent/groq-r1-postfix.json` — post-fix 420-second bounded run; the Planner completed, but the coder hit the outer run deadline.
- `whole-agent/groq-r1-postfix-extended.json` — post-fix 900-second bounded run; the Planner and coder completed, then the Reviewer failed closed on Groq HTTP 429 daily TPD exhaustion.

All three records contain credential names/presence only. None contains API keys, cookies, provider response secrets, or confidential repository content.

## Certification cross-links

- Master report: `docs/certification/codeforge-rc1-ecosystem-integration.md`
- ForgeGreen source-state record: `docs/codeforge-forgegreen-certified-source-state.json`
- Existing provider/fleet evidence is referenced from the master report and remains historical unless a record explicitly says it is current.
