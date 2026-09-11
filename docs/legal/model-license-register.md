# CodeForge Model License & Attribution Register

**Audit Date**: September 10, 2026
**Auditor**: Primary Audit Agent (Pass 1)
**Standard**: Specific open-weight license analysis, hosted API terms layering, commercial use covenants, and attribution requirements.

---

## 1. Dual-Layer Licensing Architecture

In CodeForge, model interactions operate across two legally distinct layers:
1. **The Hosting & API Layer**: Governed by the API provider's service terms (e.g., OpenRouter Terms, Google Gemini Additional Terms, Groq Terms). These terms control transmission, routing, rate limits, and resale.
2. **The Underlying Model Weights Layer**: Governed by the model creator's weight license (e.g., Meta Llama Community License, NVIDIA Open Model License, Apache-2.0). Even when accessed via an API, downstream users must comply with model-specific acceptable use policies and attribution requirements where applicable.

---

## 2. Model-Specific License Matrix

| Model Identifier (Catalog ID) | Model Family & Creator | Underlying Model License | API Provider & Hosting Layer | Commercial Use Rights | Downstream Restrictions & Attributions |
|---|---|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b:free`<br>`nvidia/nemotron-3.5-lightning:free`<br>`nvidia/nemotron-3-ultra-550b-a55b:free` | NVIDIA Nemotron<br>(NVIDIA Corporation) | **NVIDIA Open Model License Agreement** | OpenRouter (`:free` tier) | Permitted for commercial applications, subject to NVIDIA license terms. | Must preserve copyright notice and attribution; prohibited from using outputs for military/weapons or malicious surveillance. |
| `meta-llama/llama-3.1-8b-instruct`<br>`@cf/meta/llama-3.1-8b-instruct-fp8` | Meta Llama 3.1<br>(Meta Platforms, Inc.) | **Meta Llama 3.1 Community License Agreement** | OpenRouter / Cloudflare Workers AI | Permitted if licensee's monthly active users (MAU) < 700 million at release. | Must include "Built with Meta Llama 3.1" in user-facing notices. Cannot use outputs to train models other than Llama derivatives. |
| `@cf/meta/llama-3.2-1b-instruct`<br>`@cf/meta/llama-3.2-3b-instruct` | Meta Llama 3.2<br>(Meta Platforms, Inc.) | **Meta Llama 3.2 Community License Agreement** | Cloudflare Workers AI | Permitted if licensee MAU < 700 million. | Must include "Built with Meta Llama 3.2". Prohibited from violating Meta Acceptable Use Policy. |
| `@cf/qwen/qwen3-30b-a3b-fp8` | Qwen 3<br>(Alibaba Cloud / Tongyi Qianwen) | **Tongyi Qianwen License Agreement** | Cloudflare Workers AI | Permitted without royalty if monthly active users < 100 million. | Requires commercial license request from Alibaba if MAU exceeds 100 million. Attribution to Qwen team required. |
| `deepseek/deepseek-v4-flash-0731` | DeepSeek V4 Flash<br>(DeepSeek AI) | **DeepSeek Open Source License** (MIT-based with AUP) | OpenRouter | Permitted for commercial use. | Prohibits use for generating unlawful, defamatory, or cyberattack payloads. Standard MIT copyright notice retained. |
| `zai/glm-4.5-flash`<br>`zai/glm-4.7-flash` | GLM 4 Flash<br>(Zhipu AI / Z.AI) | **Zhipu AI Open Model License / Apache-2.0** | Z.AI API (Direct) | Free commercial use permitted for developer applications. | Must adhere to Zhipu AI Acceptable Use Guidelines and Chinese AI safety regulations where applicable. |
| `gemini-2.5-flash-lite`<br>`gemini-3.1-flash-lite` | Google Gemini<br>(Google LLC) | **Proprietary Weights** (No open-weight license) | Google Gemini API (Direct) | Permitted under Gemini API Terms; **EEA/CH/UK users restricted to Paid Services tier**. | Prompts/responses on Unpaid Services used to train Google products. Outputs must not be used to train competing foundational LLMs. |
| `gpt-4o-mini`<br>`gpt-5-nano` | OpenAI GPT<br>(OpenAI LLC) | **Proprietary Weights** (No open-weight license) | OpenAI API (Direct) | Permitted under OpenAI Service Terms. | Prohibits using model outputs to train competing models. API Customer Content not used for training. |
| `claude-haiku-4-5`<br>`claude-sonnet-5` | Anthropic Claude<br>(Anthropic PBC) | **Proprietary Weights** (No open-weight license) | Anthropic API (Direct) | Permitted under Anthropic Commercial Terms. | Customer Content not used for model training. Prohibits automated red-teaming or scraping without authorization. |

---

## 3. Attribution & Branding Compliance

### A. Meta Llama Attribution
Under Section 2 of the Meta Llama 3.1 and 3.2 Community License Agreements, any product that redistributes or provides access to the model or its outputs must prominently display:
> *"Built with Meta Llama 3"*

CodeForge satisfies this by clearly displaying model names and creators in the Model Selector UI (`packages/ui/src/`).

### B. NVIDIA Open Model Attribution
Under the NVIDIA Open Model License, downstream applications must include:
> *"This product contains models developed by NVIDIA Corporation."*

Recommended placement: Include in `docs/legal/drafts/third-party-notices.md` and Desktop About modal.

### C. Prohibition on Using Outputs to Train Competing Foundation Models
OpenAI, Google, and Meta all place contractual covenants prohibiting licensees from using model outputs to train, fine-tune, or evaluate competing frontier foundation models. CodeForge does not train foundation models; however, CodeForge's Acceptable Use Policy must pass this restriction down to end users.
