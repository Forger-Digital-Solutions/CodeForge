# Cognition / Devin / Windsurf SWE route discovery

**Discovery date:** 2026-09-12  
**Source policy:** Official Cognition, Devin, and Windsurf pages only. No browser credential extraction, application proxying, private endpoint discovery, or undocumented compatibility assumptions were used.

## Decision

`SWE_1_7_FREE_PRODUCT_ONLY_NOT_CODEFORGE_ROUTABLE`

No Cognition/SWE record was added to the model registry, ForgeZero, 8-Bit, or ForgeAuto. A product plan entitlement is not a CodeForge API entitlement.

## Evidence-based classification

| Route | Officially advertised state | Official model-inference API | Third-party entitlement for the advertised product access | CodeForge classification | 8-Bit / ForgeAuto |
| --- | --- | --- | --- | --- | --- |
| SWE-1.7 | Devin Desktop advertises unlimited access in its own Free product | None located in official API documentation | Not stated; Devin API credentials create Devin sessions, not SWE-1.7 model calls | `FREE_PRODUCT_ENTITLEMENT`; `SWE_1_7_FREE_PRODUCT_ONLY_NOT_CODEFORGE_ROUTABLE` | Excluded |
| SWE-1.6 | Listed as a previous-generation Devin Desktop SWE model; the Fast variant is documented for paying users | None located | No third-party model entitlement stated | `FREE_STATUS_UNKNOWN_PRODUCT_ONLY`; never infer free from age | Excluded |
| SWE-1.5 | Not listed in the current Devin Desktop model documentation | None located | None | `LEGACY_UNAVAILABLE` | Excluded |
| SWE-2 | Current Devin Desktop model; official docs state temporary self-serve product pricing of $0 through 2026-10-08, followed by listed token pricing | None located | No third-party model entitlement stated | `FREE_PRODUCT_ENTITLEMENT` during the documented product offer, never `FREE_API` | Excluded |
| Future SWE name | Unknown until current official documentation supplies all gates | Unknown | Unknown | `UNAVAILABLE` by default | Excluded |

## API and price boundary

Devin does expose a documented REST API for creating and managing **Devin sessions** with personal or service-user credentials. This proves a supported integration surface for organizations; it does not prove an OpenAI-compatible or direct SWE inference endpoint. The public API documentation identifies service users for automation, and its session API exposes a bounded `max_acu_limit`, not a selectable SWE model identifier.

The official billing documentation describes self-serve usage as included quota followed by on-demand credits, while Enterprise usage consumes ACUs at the contracted rate. Therefore a Devin-session integration is not `FREE_API`; it must be treated as `PAID_API` unless a future official pricing document specifically authorizes a zero-cost programmatic route. The Free product plan itself is limited Devin usage, separate from the Devin Desktop SWE-1.7 marketing entitlement. Current Devin Desktop documentation also advertises a temporary self-serve SWE-2 product price of $0 through 2026-10-08, followed by listed token pricing; that is likewise product pricing rather than API authorization.

## Capability and adapter finding

Devin sessions are coding-agent capable as a product, but this is not sufficient for CodeForge adapter admission:

- No official direct SWE chat/model endpoint was found.
- No official direct function/tool-call contract for an SWE model was found.
- A possible future **Devin-session delegate** is architecturally distinct from a model adapter and would require explicit pricing, workspace, cancellation, event, approval, secret-boundary, context, no-replay, and completion-gate integration.
- Such a delegate cannot be substituted into ForgeAuto/Free as if it were a stateless free model route.

## Admission checklist for a future Cognition route

Only add a candidate after official evidence establishes every item:

1. Public endpoint and supported authentication for third-party use.
2. Explicit current zero-cost programmatic pricing or an explicit transferable included entitlement.
3. Explicit authorization to use the customer entitlement from CodeForge.
4. Model identity and selectable route, including tool/coding capability and context contract.
5. Adapter implementation with health, cancellation, cooldown/rate-limit handling, exact no-replay handoff, and zero-cash enforcement.
6. ForgeZero pricing evidence and expiry policy, then 8-Bit qualification and a live zero-charge proof.

Until all six are satisfied, the route remains excluded and fails closed.

## Official sources

- Devin Desktop — free in-product SWE-1.7 statement: <https://devin.ai/desktop>
- Devin API overview and service-user integration model: <https://docs.devin.ai/api-reference/overview>
- Devin API authentication: <https://docs.devin.ai/api-reference/authentication>
- Devin API session creation and ACU limit: <https://docs.devin.ai/api-reference/v1/sessions/create-a-new-devin-session>
- Devin billing and self-serve plans: <https://docs.devin.ai/admin/billing>, <https://docs.devin.ai/admin/billing/self-serve>
- Current Devin Desktop model documentation for SWE-2, SWE-1.7, and SWE-1.6: <https://docs.devin.ai/desktop/models>
