# Final Attorney Review Packet — Pass 3 Reconciliation

<!-- PASS 3 FINAL RECONCILIATION — STRICTLY FOR OUTSIDE LEGAL COUNSEL REVIEW -->

**Date**: 2026-09-11
**Target Audience**: Outside Technology & Corporate Legal Counsel
**Instructions for Counsel**: You do NOT need to read 40 AI audit logs. This concise packet contains the **7 genuinely unresolved legal questions** requiring professional attorney judgment and formal decision. All technical facts have been physically verified against the CodeForge repository and built binaries.

---

## QUESTION 1: Google Gemini "Making API Clients Available" in the EEA

### The Question
Does distributing a desktop software application to users in the European Economic Area (EEA), where users enter their own Google AI Studio API key (BYOK), constitute "making API Clients available to users in the EEA" under Google's Gemini API Additional Terms of Service?

### Why It Matters
Google's terms explicitly mandate: *"You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom."* If distributing an open-source or commercial desktop client that connects to the Gemini Unpaid tier falls under this clause, CodeForge could face contractual claims from Google for distributing the software to European users without enforcing Paid Google Cloud projects.

### Verified Technical Facts (`REPOSITORY_FACT`)
- CodeForge Desktop is a local client application.
- The end-user supplies their own `GEMINI_API_KEY` obtained from Google AI Studio.
- The client sends HTTP requests directly from the user's workstation to Google's API. No CodeForge cloud server is in the traffic path.

### Primary Authority (`EXTERNAL_CONTRACT_FACT`)
- Google Gemini API Additional Terms of Service (March 23, 2026), Section: "Use Restrictions / Geographical Availability".

### AI Analysis & Remaining Ambiguity
- *Argument A (User is Client)*: The user is the deployer who configures their personal API key; CodeForge is merely a tool.
- *Argument B (Developer is Client Deployer)*: Google defines an "API Client" as "a website, application, or other service that uses the Services". Under this reading, CodeForge is the entity "making the application available" in the EEA.

### Desired Attorney Decision
Advise whether CodeForge Desktop BYOK may be distributed to EEA users without georestrictions, or if CodeForge must warn/block EEA users from configuring Unpaid Gemini keys.

---

## QUESTION 2: OpenRouter Multi-Tenant Cloud Proxying & Section 7.4

### The Question
If CodeForge Cloud aggregates free user requests and routes them to OpenRouter `:free` models via a single CodeForge-owned API key without charging users for inference, does this violate OpenRouter ToS §7.3 (bypassing limits via multiple users) or §7.4 (reselling API access / competing service)?

### Why It Matters
CodeForge's "ForgeZero" feature aims to offer free inference routing. If OpenRouter deems this a violation of standard terms, CodeForge's corporate account could be terminated, abruptly breaking cloud routing for all users.

### Verified Technical Facts (`REPOSITORY_FACT`)
- In `apps/cloud-api`, CodeForge maintains a centralized server that accepts user prompts and dispatches calls to `openrouter.ai` using a shared environment API key.
- CodeForge does not charge users for the `:free` model routes.

### Primary Authority (`EXTERNAL_CONTRACT_FACT`)
- OpenRouter Terms of Service (August 31, 2026), Section 7.3 and Section 7.4.

### Desired Attorney Decision
Confirm whether an **OpenRouter Enterprise Agreement** is mandatory before launching CodeForge Cloud hosted routing, or if standard developer terms permit $0 passthrough proxying.

---

## QUESTION 3: Secondary Liability for User-Submitted Employer Trade Secrets

### The Question
Because Google's Unpaid Gemini tier explicitly permits Google to use submitted prompts for model training and human annotation, does CodeForge face secondary liability (e.g., contributory copyright infringement or trade secret misappropriation) if an end-user prompts CodeForge with their employer's proprietary source code?

### Why It Matters
Enterprise employers whose proprietary code leaks into Google's public model training data may seek remedies against tool vendors that facilitated the transmission.

### Verified Technical Facts (`REPOSITORY_FACT`)
- CodeForge includes automated secret scanning (`packages/secrets`) that redacts credentials (API keys, RSA keys).
- However, business logic, algorithms, and proprietary source code are transmitted in prompt context.

### Desired Attorney Decision
Review and approve the liability disclaimers and user indemnity provisions in Section 4 of the proposed `terms-of-service.md` and Section 5 of `privacy-policy.md`. Confirm whether a prominent UI warning badge provides sufficient safe harbor under U.S. and E.U. law.

---

## QUESTION 4: Local Workstation Data & GDPR Controller Scope

### The Question
Does a desktop software vendor act as a "data controller" under GDPR Article 4(7) with respect to personal data and prompt histories stored solely in a local SQLite database residing on an end-user's physical workstation?

### Why It Matters
Pass 1 claimed that GDPR Article 17 (Right to Erasure) applies to local SQLite databases, which would theoretically require CodeForge to invent a remote file-deletion mechanism. Pass 2 and Pass 3 concluded CodeForge is not a controller for local workstation files.

### Primary Authority (`STATUTORY_FACT`)
- GDPR Regulation (EU) 2016/679, Article 4(7) and Article 17.

### Desired Attorney Decision
Confirm our legal conclusion that Forger Digital Solutions is NOT a data controller for local workstation SQLite data, and that GDPR Article 17 erasure obligations attach solely to accounts registered on the hosted CodeForge Cloud platform.

---

## QUESTION 5: Host OS Command Execution Liability & Safe Harbor

### The Question
Are the proposed warranty disclaimers, limitation of liability clauses, and user approval workflows sufficient to shield Forger Digital Solutions from liability if an autonomous agent executes a terminal command that damages a user's operating system or deletes local files?

### Why It Matters
CodeForge agents execute commands directly via `child_process.spawn("cmd.exe")` on the user's host machine. While directory boundaries and timeouts are enforced, commands inherit the user's local permissions.

### Desired Attorney Decision
Review Section 5 ("Autonomous Tool Execution") of the proposed `terms-of-service.md` to ensure maximum enforceability under U.S. state laws and E.U. consumer protection directives.

---

## QUESTION 6: Governing Law, Arbitration & Class Action Waiver

### The Question
Should CodeForge mandate binding individual arbitration and a class-action waiver in its commercial Terms of Service, and what governing law is recommended?

### Options for Counsel
- **Option A**: State of Delaware governing law; American Arbitration Association (AAA) binding arbitration; standard class action waiver. (Standard SaaS defense posture).
- **Option B**: State of California / user's home jurisdiction; judicial forum in federal/state courts. (More open-source friendly, but increases litigation exposure).

### Desired Attorney Decision
Advise on the optimal dispute resolution clause for a hybrid open-source developer tool with optional cloud subscriptions.

---

## QUESTION 7: Trademark Clearance Posture for "CodeForge"

### The Question
Given that preliminary searches reveal third-party software tools using the name "CodeForge" (e.g., in VS Code extensions and fuzzing tools), what is counsel's recommendation regarding brand adoption, common-law trademark risks, and filing for federal registration in USPTO Class 009 and Class 042?

### Desired Attorney Decision
Advise whether to proceed with a formal comprehensive trademark clearance search before launching commercial marketing.
