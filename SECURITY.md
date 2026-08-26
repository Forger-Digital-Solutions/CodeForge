# CodeForge — Security

## Zero-Billing Guarantee

CodeForge's `ForgeZero` subsystem is architecturally incapable of intentionally routing to
paid inference. Models must pass verification (cost, free status, no paid fallback) before
becoming eligible. Fail-closed: unverified models are rejected.

## No Local LLM Inference

CodeForge does not run LLM inference locally. The provider interface is architected so this
rule is enforced centrally, not by convention.

## Provider Credentials

Stored using OS secure facilities (Windows DPAPI/Credential Manager). Never unencrypted
in project files.

## Execution Safety

- Workspace boundary: agents confined to repo + allowed temp paths
- Command-risk classification (not just string matching)
- Secret scanning/redaction before context reaches any model
- Cooperative cancellation with descendant process cleanup
- Bounded retry budgets prevent infinite loops

## Reporting

Report security issues to the maintainers. Do not file public issues for vulnerabilities.
Full policy in `SECURITY.md` (expanded in later phase).
