# Business Decisions Delta — Pass 2 Independent Review

<!-- PASS 2 ADVERSARIAL REVIEW — NOT LEGAL ADVICE — DRAFT ONLY -->

## Overview
This document isolates the pure business and leadership decisions required before commercial launch. Pass 2 eliminated several false-alarms from Pass 1, leaving a core set of existential business choices.

## 1. The Open-Source vs. Proprietary Declaration (P0)
Pass 1 correctly identified the missing root `LICENSE`. Pass 2 emphasizes the scope: all 39 internal packages lack a license declaration.
- **The Decision:** Will CodeForge be released under an Open Source license (e.g., MIT, Apache 2.0) or a proprietary commercial EULA?
- **Why it matters now:** VS Code extension publishing is blocked without a license. Furthermore, "Zero Cost" marketing often implies open-source to the developer community. Ambiguity prevents community contributions and enterprise adoption.

## 2. Cloud Proxy vs. BYOK Strategy (P1)
Pass 2 identified significant Terms of Service friction if CodeForge operates a centralized Cloud API that aggregates users and proxies requests to OpenRouter or Gemini (ForgeZero).
- **The Decision:** Will CodeForge launch as a purely "Bring Your Own Key" (BYOK) thick-client desktop application, OR will it launch with the centralized Cloud API enabled?
- **Why it matters now:** 
  - If pure BYOK: CodeForge avoids OpenRouter "reselling/aggregation" bans, avoids GDPR cloud liabilities, and pushes Gemini EEA compliance onto the user.
  - If Cloud Proxy: CodeForge MUST build GDPR deletion pipelines, MUST geoblock EEA users from Gemini Unpaid, and MUST seek an Enterprise Agreement with OpenRouter.

## 3. Handling Google Gemini API Key Deprecation (P1)
Pass 2 discovered that Google has deprecated standard API keys for new projects.
- **The Decision:** Should engineering halt feature work to rewrite the Gemini authentication flow to support Service Accounts/OAuth, or should CodeForge launch with Gemini marked as "Legacy / Enterprise Only" and push users toward OpenRouter?
- **Why it matters now:** Launching a broken BYOK integration for the most popular free model (Gemini 1.5 Flash/Lite) will severely damage day-one user trust.

## 4. Binding Arbitration and Class Action Waivers (P2)
Pass 1 automatically injected aggressive arbitration clauses into the draft Terms of Service. Pass 2 stripped them out.
- **The Decision:** Does CodeForge leadership want to enforce binding arbitration and block class-action lawsuits?
- **Why it matters now:** This is a standard tech defense posture, but it is deeply unpopular in developer/open-source communities. It is a brand decision as much as a legal one.

## 5. Stripe "Test Mode" Gate (P2)
Pass 1 flagged the use of `sk_test_` keys.
- **The Decision:** Is CodeForge ready to activate real-money billing, or is the upcoming release intended as a free Beta / Sandbox?
- **Why it matters now:** Activating live billing requires finalizing the Terms of Service, refund policies, and PCI-compliance audits for the Cloud API.
