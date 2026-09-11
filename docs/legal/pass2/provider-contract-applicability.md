# Provider Contract Applicability — Pass 2 Independent Review

<!-- PASS 2 ADVERSARIAL REVIEW — NOT LEGAL ADVICE — DRAFT ONLY -->

## Audit Scope
Pass 2 independently verified the Terms of Service for OpenRouter (Last Updated: August 31, 2026) and Google Gemini API (Effective March 23, 2026). Pass 1 raised existential concerns regarding Section 7(4) of OpenRouter terms and regional restrictions in Gemini terms. Pass 2 tests these claims against CodeForge's specific technical architectures.

## 1. OpenRouter Applicability Analysis

### The Contract Text (Section 7)
- **[CONTRACT TEXT]** Section 7(3): Users may not "create a false identity, misrepresent your identity, or create multiple accounts as a single user, for purposes of bypassing or circumventing use limits on the Site or Service or for any other reason;"
- **[CONTRACT TEXT]** Section 7(4): Users may not "access the Site or Service for purposes of reselling API access to Models or otherwise developing a competing service;"

### Architecture Assessment: CodeForge BYOK (Bring Your Own Key) Desktop
- **[REPOSITORY FACT]** In Desktop BYOK mode, the end-user provides their *own* OpenRouter API key. CodeForge routes traffic directly from the user's IP to `openrouter.ai`.
- **[LEGAL INTERPRETATION]** The end-user is the OpenRouter API Client. CodeForge is merely a thick-client user agent. CodeForge is NOT reselling API access. Section 7(4) does not prohibit this.
- **[DISPOSITION]** **Pass 1 P0 DISPROVED.** BYOK Desktop mode is fully legally compliant with OpenRouter terms.

### Architecture Assessment: CodeForge Cloud / ForgeZero Hosted Routing
- **[REPOSITORY FACT]** If CodeForge hosts the routing (e.g., via `apps/cloud-api`), multiple CodeForge users share CodeForge's OpenRouter API key.
- **[LEGAL INTERPRETATION]** If CodeForge charges users for this access, it could be construed as "reselling API access" (violating 7(4)). If CodeForge provides it for free (ForgeZero), it is not "reselling," but it aggregates multiple users behind one account, which could violate 7(3) if it bypasses rate limits.
- **[DISPOSITION]** **Pass 1 P0 CONFIRMED WITH NARROWER SCOPE.** Hosted cloud routing requires an Enterprise Agreement or written exemption from OpenRouter.

### 8-Bit Qualification Traffic
- **[REPOSITORY FACT]** `packages/eight-bit/src/qualification/runner.ts` systematically tests model capabilities.
- **[LEGAL INTERPRETATION]** This is standard benchmarking/qualification, not "Red Teaming" (Section 8 explicitly defines Red Teaming as "adversarial action designed to compromise"). However, if 8-Bit qualification consumes excessive free-tier bandwidth, it may violate fair use policies.
- **[ENGINEERING RECOMMENDATION]** Ensure 8-Bit runner respects HTTP 429 rate limits rigorously (confirmed via `health.ts` exponential backoff).

## 2. Google Gemini API Applicability Analysis

### The Contract Text (Regional Restrictions)
- **[CONTRACT TEXT]** "You may only access the Services (or make API Clients available to users) within an available region. You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom."

### Architecture Assessment: CodeForge BYOK Desktop
- **[REPOSITORY FACT]** End-user provides a `GEMINI_API_KEY`.
- **[LEGAL INTERPRETATION]** The end-user is the API Client deployer. If an EEA user utilizes their own free-tier API key in CodeForge Desktop, the user violates Google's terms, not CodeForge. CodeForge is not "making API Clients available" in the cloud sense; it distributes software.
- **[ATTORNEY QUESTION]** Does distributing a pre-configured software application with a Gemini BYOK integration constitute "making API Clients available" under Google's definition?

### Architecture Assessment: CodeForge Cloud Hosted Routing
- **[LEGAL INTERPRETATION]** If CodeForge hosts the Gemini proxy, CodeForge is unequivocally the API Client. CodeForge MUST NOT route EEA users to the Unpaid Gemini API.
- **[DISPOSITION]** **Pass 1 P1 CONFIRMED.**

### Unpaid vs. Paid Data Use
- **[CONTRACT TEXT]** Unpaid Services: "Google uses the content you submit... to provide, improve, and develop Google products... To help with quality and improve our products, human reviewers may read, annotate, and process your API input and output."
- **[CONTRACT TEXT]** Paid Services: "Google doesn't use your prompts... or responses to improve our products, and will process your prompts and responses in accordance with the Data Processing Addendum."
- **[BUSINESS DECISION]** CodeForge must not submit proprietary CodeForge source code through Unpaid Gemini Services, or it grants Google a license to use it for training.

### NEW FINDING: Google API Key Deprecation
- **[REPOSITORY FACT]** CodeForge currently uses standard API keys for Gemini auth.
- **[EXTERNAL FACT]** As of June 19, 2026, Google deprecated standard API keys in favor of service-account auth keys for new projects. By September 2026, many standard keys are rejected.
- **[DISPOSITION]** **NEW P1 (TECHNICAL/COMMERCIAL).** The BYOK Gemini flow may be entirely broken for new users.

## 3. Unresolved Items
- **[BUSINESS DECISION REQUIRED]** Will CodeForge seek an OpenRouter Enterprise Agreement to legitimize cloud-hosted multi-tenant routing?
- **[ATTORNEY REVIEW REQUIRED]** Define "API Client" in the context of a distributed thick-client desktop application.
