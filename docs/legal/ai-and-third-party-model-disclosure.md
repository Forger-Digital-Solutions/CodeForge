# AI and Third-Party Model Disclosure

<!-- DRAFT — user-facing disclosure; publish with the Privacy Policy after owner/counsel review -->

CodeForge is an autonomous coding agent. To do its work it sends text to artificial-intelligence
models operated by third parties. This page explains, in plain language, what that means for
your code and your data.

## 1. Your prompts and code go to the model provider that serves your request

When CodeForge asks a model to plan, write, review, or explain code, it sends the model:

- your instruction (the prompt),
- the parts of your repository it selected as context (file excerpts, diffs, search results, command output),
- tool results from the steps it took.

That content is transmitted to the provider serving the route. Which provider depends on the
route family you are using:

| Route family | Whose credentials | Path |
| --- | --- | --- |
| **ForgeAuto / Managed Free (Hosted Free)** | CodeForge's own platform credentials | Your machine → CodeForge Cloud (relay, not stored) → the ForgeZero-verified free provider selected for the request |
| **Paid Auto** (test mode today) | CodeForge's platform credentials | Same relay path, paid routes |
| **Individually selected paid models** and **BYOK / direct providers** | Your own provider account | Your machine → the provider directly; CodeForge Cloud is not involved |
| **User-connected free candidates** (e.g. Ollama Cloud, rollout-gated) | Your own provider account | Your machine → the provider directly |

CodeForge minimizes what it sends: it packs only the context the task needs, excludes credential
files (`.env*`, key and certificate files, `credentials.*`, `secrets.*`) from context by path,
and passes tool output through a secret redactor before the model sees it.

## 2. Different providers have different privacy and retention policies

CodeForge does not control what a provider does with the content it receives. Each provider's
own terms apply — including whether it retains prompts, for how long, and whether it may use them
to improve its models. CodeForge does **not** claim that any provider has "zero retention".

Known, provider-stated facts CodeForge relies on for routing policy:

- Google's **unpaid** Gemini API tier states that prompts and outputs may be used for training and reviewed by humans. CodeForge's **Strict** privacy routing mode excludes such tiers from ForgeAuto; do not send confidential code on that tier.
- Paid/enterprise API tiers of major providers generally state that API inputs are not used for training; those are the providers' commitments, not CodeForge's.
- Where a provider's per-model retention terms are not published or not evidenced, CodeForge treats them as **unknown** rather than assuming "no retention".

The privacy routing mode (Settings › Data & Privacy) — Strict / Standard / Maximum Free — is
the control you have over this trade-off for ForgeAuto.

## 3. BYOK creates a direct relationship between you and the provider

When you connect your own API key, requests go from your machine to that provider under your
account. The provider's terms, pricing, and privacy policy govern that traffic. CodeForge stores
your key sealed on your device with operating-system-backed encryption, never uploads it, and
never uses it for any other user or route family.

## 4. Managed Free and Paid Auto credentials stay on CodeForge's servers

The platform credentials that power Hosted Free and Paid Auto never leave CodeForge Cloud. Your
desktop receives only the model's streamed response. The model never receives those
credentials, your CodeForge identity, or your GitHub identity.

## 5. CodeForge does not train models on your content

CodeForge trains no models. Your prompts, code, and outputs are not used to train CodeForge
models. CodeForge Cloud does not store prompt or completion text from hosted requests; it records
only usage accounting (provider, model, token counts, cost, status).

## 6. Please keep secrets out of what you send

CodeForge attempts to redact credentials it recognises in context and tool output, but pattern
redaction cannot recognise every secret. You remain responsible for repository hygiene: keep
credentials out of source files, use the excluded file names for secrets, and review context
before sending confidential material to a provider whose terms you have not read.

## 7. AI-generated code can be wrong

Models make mistakes: incorrect logic, insecure patterns, invented APIs, licence-incompatible
snippets, unnecessary dependencies. CodeForge's verification systems (ForgeVerify, tests,
reviewers) reduce risk but cannot guarantee correctness or security. Autonomous execution runs
within the permissions and approvals you configure. You are responsible for reviewing generated
changes, dependencies, and licences before you rely on or deploy them. See the Terms of Service
and the AI output disclaimer.

## 8. Where to look for the details

- Data flow: `docs/security/data-flow.md`
- Provider-by-provider terms analysis: `docs/legal/provider-terms-register.md`, `docs/legal/third-party-services-register.md`
- Sub-processors: `docs/legal/subprocessor-list.md`
- Privacy Policy: `docs/legal/pass3/proposed-drafts/privacy-policy.md`
