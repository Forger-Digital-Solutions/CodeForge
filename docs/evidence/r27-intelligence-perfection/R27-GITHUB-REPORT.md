# R27 GitHub Publication Report

Status: `R27_GITHUB_PUBLICATION_DETERMINISTICALLY_PROVEN_LIVE_WORKFLOW_NOT_PROVEN`

## Findings

The Cloud publication path correctly performs local artifact, authorization, push, and PR
reconciliation work, but its PR client accepted a response missing the certified head SHA. It also
could accept a closed PR during a retry. Both outcomes are incompatible with a truthful completed
publication receipt. The access-model document also lagged the implemented signed-webhook service.

## R27 correction

Cloud now accepts a PR only when it is open, references the managed branch and expected base, and
reports the exact certified commit SHA. Missing or different SHA data and closed PRs fail with the
stable retryable `PULL_REQUEST_RECONCILIATION_FAILED` code. The security documentation now describes
the existing raw-body HMAC verification, durable delivery deduplication, and scoped revocation path.

## Deterministic validation

Eight OAuth, GitHub App, webhook, publication, PR-client, and Desktop-to-Cloud bridge suites passed
58 tests. The fixture uses a synthetic installation token, a local bare remote, and a fake GitHub
HTTP service; it proves no token reaches the desktop fixture. Cloud Auth and Cloud API typechecking
passed.

## Boundary

No GitHub account or external repository was touched. Real OAuth/App consent, remote branch push,
PR creation, CI inspection, CI repair, and follow-up push remain unproven. CI/check-run inspection
is not currently implemented under the deliberately narrow GitHub App permission surface; adding it
requires an explicit product and external-permission decision.
