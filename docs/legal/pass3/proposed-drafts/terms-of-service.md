# CodeForge Terms of Service

<!-- DRAFT — NOT YET EFFECTIVE — PENDING BUSINESS AND LEGAL REVIEW -->
<!-- Technical facts reconciled with the repository on 2026-09-18 (Security / Legal / Trust R1). -->

**Notice**: This document is an unexecuted legal draft prepared for CodeForge (a product of `[LEGAL ENTITY NAME — OWNER INPUT REQUIRED]`, "Forger Digital Solutions"). It does not constitute binding terms until formally approved, dated, and published by authorized leadership after legal review. Clauses marked for attorney review are drafts, not positions.

---

## 1. Acceptance of Terms
By downloading, installing, accessing, or using the CodeForge desktop application ("Desktop App") or the CodeForge cloud service ("Cloud Service"), collectively referred to as the "Services", you agree to be bound by these Terms of Service ("Terms"). If you do not agree, you must immediately cease using the Services and uninstall the Desktop App.

## 2. Eligibility & 18+ Age Requirement
You must be at least **18 years of age** to access or use the Services. By accessing the Services, you represent and warrant that you are 18 years of age or older and possess the legal capacity to enter into these Terms. If you are under 18, you are strictly prohibited from using CodeForge. (This requirement flows down directly from upstream AI model provider terms).

## 3. Architecture & Separation of Services
CodeForge operates as a hybrid software system consisting of two distinct components:
- **Local Desktop Application**: Software running on your personal or organizational workstation. You control your local files, repositories, and local SQLite session databases.
- **CodeForge Cloud Service**: Optional hosted infrastructure providing GitHub-based sign-in, hosted model routing with monthly allowances ("Hosted Free", and paid routes where enabled), publication of certified commits to your GitHub repositories through a GitHub App you install, and billing. It does not host, index, or retain your repositories; see the Privacy Policy for exactly what it processes.

## 4. Third-Party AI Inference & Bring Your Own Key (BYOK)
- **User-Configured Credentials**: You may configure your own API credentials ("BYOK") from third-party AI providers (including OpenRouter, Google Gemini, Groq, and Cloudflare). When using your own API keys, your interaction with those providers is governed strictly by your independent agreement with each provider.
- **Provider Terms Compliance**: You agree to comply with all acceptable use policies, rate limits, and terms of service imposed by any third-party AI provider you connect to CodeForge.
- **Unpaid Tier Warning**: You acknowledge that certain free or unpaid AI services (such as the Google Gemini Unpaid tier) explicitly permit the provider to use submitted prompts and generated outputs for model training and human review. You are solely responsible for verifying whether your code or prompts may lawfully be submitted to such tiers.

## 4A. GitHub Access and Publication
- **Sign-in scope**: signing in with GitHub grants CodeForge read access to your public profile and the email addresses you authorize — nothing else. It grants no repository access.
- **Publication authority**: repository write access exists only if you install the CodeForge GitHub App on repositories you select. CodeForge uses that installation to push the commits you choose to publish and to open pull requests, using tokens limited to one repository at a time. You may uninstall the App on GitHub at any time, which ends CodeForge's ability to publish.
- **Your responsibility**: you are responsible for the repositories you authorize, for reviewing pull requests CodeForge opens before merging them, and for complying with GitHub's terms and your organization's policies.

## 4B. AI-Generated Code
- **It can be wrong**: AI-generated code, explanations, and plans may contain errors, insecure patterns, invented interfaces, and unsuitable or licence-incompatible dependencies. CodeForge's verification systems (including ForgeVerify) reduce, but cannot eliminate, that risk and do not guarantee correctness, security, or fitness for any purpose.
- **You review before you rely**: you are responsible for reviewing generated changes, running your own tests, reviewing the licences of any dependency or snippet the agent introduces, and deciding what to deploy. Security-sensitive changes require your review and testing.
- **Autonomy is bounded by your settings**: the agent executes within the execution mode, permissions, and approvals you configure. Approving a command authorizes CodeForge to run it on your machine with your privileges.
- **Model providers**: the model that generates a response is operated by a third party under its own terms (Section 4 and the AI and Third-Party Model Disclosure).

## 4C. Plans, Allowances, Quotas, and Rate Limits
- **Free services**: the Desktop App, CLI, and VS Code extension may be used with your own provider credentials at no charge from CodeForge. A free CodeForge Cloud account includes a monthly hosted allowance (currently 500,000 credits and one concurrent hosted task) that resets each period and does not roll over.
- **Paid plans**: paid plans, credit packs, prices, renewal, and refunds are described in the Subscription & Commercial Billing Terms. Nothing is "unlimited": every route is subject to the allowance of your plan, per-request cost ceilings, provider rate limits, concurrent-task limits, and operator safety limits (including a global daily spend cap) that may make a route temporarily unavailable.
- **Provider availability**: free routes depend on third-party providers' free allowances and terms, which may change or be withdrawn without notice. CodeForge fails closed — it will decline to route rather than incur unverified cost — and does not guarantee availability of any particular model or provider.
- **Fair use**: CodeForge may rate-limit or suspend accounts that abuse hosted routes, attempt to evade limits, or violate the Acceptable Use Policy.

## 5. Autonomous Tool Execution & Host Operating System Environment
- **Local Command Execution**: CodeForge agents possess autonomous capabilities to inspect files, edit code, and execute terminal commands directly within your local operating system environment.
- **User Responsibility & Approval**: While CodeForge enforces workspace boundary confinement, environment sanitization, execution timeouts, and approval gates, commands execute with your ambient user privileges on your host operating system. You are solely responsible for reviewing agent proposed actions before granting approval. CodeForge disclaims all liability for system damage, file deletion, or data loss resulting from commands you approve.

## 6. Intellectual Property & User Code
- **Ownership of Your Code**: Forger Digital Solutions claims no ownership, copyright, or intellectual property rights over the source code, repositories, or prompts you open or process within the Desktop App.
- **License to CodeForge Cloud**: If and only if you utilize CodeForge Cloud features, you grant CodeForge a limited, non-exclusive, worldwide license to host, process, and transmit your prompts and session data solely as necessary to deliver the Cloud Service to you.
- **AI Output**: CodeForge makes no claims of copyright ownership over AI-generated outputs. Rights in AI-generated outputs are subject to applicable law and the terms of the specific model provider that generated the response.
- **Confidentiality**: CodeForge treats your repository content and prompts as confidential work product. CodeForge Cloud does not store the text of prompts or model outputs, does not use your content to train models, and transmits content only to the provider serving your request (Section 4) and to GitHub when you publish (Section 4A). Content you send to a third-party provider is governed by that provider's terms.

## 7. Acceptable Use
You agree not to use CodeForge to:
- Generate malware, exploits, viruses, or malicious software.
- Violate any applicable local, state, national, or international law.
- Circumvent or bypass rate limits, quotas, or billing firewalls of CodeForge or any third-party provider.
- Interfere with or disrupt the integrity or security of CodeForge Cloud infrastructure.

## 7A. Accounts, Cancellation, and Termination
- **Your account**: you are responsible for activity under your CodeForge account and for keeping your GitHub account secure. Sign out of devices you no longer control; you can delete your account at any time from Settings (deletion is described in the Privacy Policy).
- **Termination by us**: we may suspend or terminate access for violation of these Terms or the Acceptable Use Policy, for legal reasons, or to protect the service, providers, or other users; where practical we will notify you.
- **Effect**: on termination your right to use the Cloud Service ends; the Desktop App continues to work with your own provider credentials. Sections 4B, 6, 8, and 9 survive termination.

## 8. Disclaimers & Limitation of Liability
- **"AS IS" WARRANTY**: THE SERVICES AND ALL AI-GENERATED CODE ARE PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, OR ACCURACY.
- **LIMITATION OF LIABILITY**: TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT SHALL FORGER DIGITAL SOLUTIONS, ITS DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE FOR ANY INDIRECT, PUNITIVE, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR EXEMPLARY DAMAGES, INCLUDING LOSS OF PROFITS, DATA LOSS, OR WORK STOPPAGE, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF THE SERVICES. `[ATTORNEY REVIEW REQUIRED: aggregate liability cap, consumer-law carve-outs, and whether an indemnity clause is appropriate]`

## 9. Governing Law & Dispute Resolution
- **Governing Law**: `[GOVERNING LAW — LEGAL REVIEW REQUIRED]`.
- **Dispute Resolution**: `[DISPUTE RESOLUTION — LEGAL REVIEW REQUIRED]`.

## 10. Modifications
We reserve the right to modify these Terms. We will provide notice of material modifications by updating the effective date and, for signed-in users, by in-app notification or email to the address linked to your account; continued use after the effective date constitutes acceptance where permitted by law.

## 11. Contact
`[LEGAL ENTITY NAME — OWNER INPUT REQUIRED]` · `[MAILING ADDRESS — OWNER INPUT REQUIRED]` · `[LEGAL CONTACT — OWNER INPUT REQUIRED]`

Related documents: Privacy Policy, Acceptable Use Policy, Subscription & Commercial Billing Terms, AI and Third-Party Model Disclosure (`docs/legal/ai-and-third-party-model-disclosure.md`), Security & Vulnerability Disclosure Policy.
