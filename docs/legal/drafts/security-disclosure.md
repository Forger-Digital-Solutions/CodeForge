# CodeForge Vulnerability Disclosure & Security Policy

**Status**: REVIEW DRAFT (PASS 1)
**Notice**: This document is a non-binding draft prepared for licensed attorney review and executive business determination. Safe-harbor legal commitments are marked `[ATTORNEY REVIEW REQUIRED]`.

---

**Last Updated**: [BUSINESS DECISION REQUIRED: Effective Date]

At CodeForge, security is central to our engineering mission. We welcome coordinated vulnerability reports from independent security researchers, developers, and users to ensure the safety and integrity of our software ecosystem.

---

## 1. Scope of Vulnerability Research

### In-Scope Assets:
- CodeForge Desktop Client (`apps/desktop`)
- CodeForge Local Server & CLI (`packages/server`, `packages/core`)
- CodeForge Cloud API (`apps/cloud-api`, `api.codeforge.dev`)
- ForgeZero Firewall & Evaluator (`packages/forge-zero`)
- Local Credential Encryption & Secret Redaction Subsystems (`packages/secrets`)

### Out-of-Scope Assets:
- Third-party AI model provider APIs (OpenRouter, Google, Groq, OpenAI, Anthropic) — report directly to the respective provider.
- Physical attacks, denial-of-service (DoS) against local workstations, or social engineering targeting CodeForge contributors.
- Vulnerabilities requiring unprivileged local physical access to an already compromised host machine.

---

## 2. Reporting Guidelines & Process

If you believe you have identified a security vulnerability in CodeForge, please report it privately:
1. **Email**: Send vulnerability details to `security@codeforge.dev`.
2. **Encryption**: Where feasible, encrypt sensitive vulnerability details and proof-of-concept exploits using our security team PGP public key [BUSINESS DECISION REQUIRED: Key Fingerprint Link].
3. **Information to Include**:
   - Detailed description of the vulnerability and attack vector;
   - Step-by-step reproduction steps or minimal proof-of-concept script;
   - Affected component version and operating system environment;
   - Assessment of potential impact.

---

## 3. Coordinated Disclosure & Response Timeline

We adhere to standard coordinated vulnerability disclosure practices:
- **Acknowledgment**: We strive to acknowledge receipt of vulnerability reports within three (3) business days.
- **Triage & Status**: We will provide an initial assessment and status update within ten (10) business days.
- **Remediation Window**: We request that researchers allow a ninety (90) day remediation window from acknowledgment before publicly disclosing vulnerability details, enabling us to release security patches across supported platforms.

---

## 4. Legal Safe Harbor Framework

[ATTORNEY REVIEW REQUIRED: Formal adoption of safe harbor commitments creates enforceable legal covenants. Outside counsel must review and approve the following terms before publication.]

If you conduct security research in good faith and in strict compliance with this policy:
1. **No Legal Action**: CodeForge will not initiate or support legal action against you for accidental, good-faith violations of access boundaries occurring solely within the scope of your research;
2. **CFAA / DMCA Safe Harbor**: CodeForge considers security research conducted in compliance with this policy to be authorized access under the Computer Fraud and Abuse Act (CFAA) and will not pursue civil claims for circumvention of technological measures under DMCA § 1201;
3. **No Bounty Promises**: [BUSINESS DECISION REQUIRED: CodeForge currently does not operate a paid cash bug bounty program. Valid researchers will be publicly acknowledged in our Security Hall of Fame unless they request anonymity.]
