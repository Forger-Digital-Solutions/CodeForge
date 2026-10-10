# R73 live role qualification

All live cases used public synthetic code. Anonymous Kilo and BlockRun calls carried no account key or payment credential. Exact available catalog price and provider policy were checked before requests. The prior campaign used `R73_ROLE_QUALIFICATION_V6 / REVIEWER_PROTOCOL_V3`; the current frozen suite is `R73_ROLE_QUALIFICATION_V7 / REVIEWER_PROTOCOL_V4`, with the same production schema/prompt, 0.75 acceptance threshold, and additional current-source positive/negative boundary cases.

## Reviewer results

| Provider/model | Evidence | Measured outcome |
| --- | --- | --- |
| BlockRun `nvidia/llama-3.2-11b-vision` | `blockrun-reviewer-1791479821776.json`, per-run observation file named inside it | **QUALIFIED, 5/6, seven requests.** Correct bug, clean-diff, swallowed-error, resource-lifetime and test-weakening judgments; clean-comment false positive retained. No Coder or Tool Agent promotion. |
| Kilo Cohere North Mini Code | `reviewer-cohere_north-mini-code_free-1791479086989.json` | V5 hard failure, four of six. Production-schema malformed output and missed defect remain negative evidence. |
| Kilo Dots | `reviewer-dots-studio_dots-3-note-preview_free-1791469967716.json`, `...1791479228680.json`, `...1791540616465.json` | Earlier organic in-band/SSE502; latest bounded retry emitted eight actual requests, two passing cases, hard failures and empty output. Not qualified; the local counter of nine includes a refused invocation and is not nine actual POSTs. |
| Kilo Nemotron Lightning | `reviewer-nvidia_nemotron-3.5-lightning_free-1791478615107.json` | Deadline/timeout and reasoning leakage; inconclusive. This exposed the local timeout classification defect repaired in R73. |
| Kilo Liquid | `reviewer-liquid_lfm-2.5-2.6b_free-1791478991059.json` | Exact-model upstream 429; inconclusive. This exposed the overly broad cooldown scope repaired in R73. |
| Kilo Nemotron Super | `reviewer-nvidia_nemotron-3-super-120b-a12b_free-1791479328096.json`, `...1791479717487.json` | V5 probation then V6 hard failure; no qualified Reviewer claim. |
| Kilo Nemotron Ultra | `reviewer-nvidia_nemotron-3-ultra-550b-a55b_free-1791479634287.json` | Upstream failure; inconclusive. |
| Kilo Poolside Laguna S | `reviewer-poolside_laguna-s-2.1_free-1791480508273.json` | One request, organic upstream-account 429; inconclusive, no retry or qualification. |

The original individual receipts and failures are preserved. `blockrun-reviewer-qualified-v3.json` is a schema-validated projection of the measured BlockRun role output using the shared production receipt builder, with a SHA-256 link to the unchanged original evidence. It stamps the protocol actually executed; it does not run additional cases or change their outcomes. The earlier derived receipt without the explicit protocol marker remains historical evidence and is no longer sufficient for current Reviewer admission.

Current V4 live-only checks are not qualifications. BlockRun `nvidia/llama-3.2-11b-vision` made eight exact-model calls: it correctly caught the planted arithmetic, telemetry, reservation-leak, and weakened-test defects, but falsely rejected a clean comment and the actual corrected retry-boundary case; a local request bound interrupted the last case. Kilo `nvidia/nemotron-3-super-120b-a12b:free` made ten calls: it approved the correct retry fix but also approved the disqualifying reservation-leak regression; a local request bound interrupted the last case. Neither run had an upstream error, neither model is V4-qualified, and neither receipt permits Reviewer dispatch. The raw receipts retain the earlier script status; `reviewer-v4-live-adjudication.json` reclassifies both as local-bound rather than provider failures.

BlockRun's subsequently available `poolside/laguna-xs-2.1` made four bounded requests: one empty completion followed by three responses identifying Llama rather than the requested model. Exact served-model checks rejected substitution. Neither Laguna XS nor the substituted responses were qualified; a provider's fallback cannot inherit another model's measured capability. `blockrun-compact-1791538496172.json`, its raw observation file and `blockrun-laguna-identity-interpretation-1791538943472.json` preserve the outcome. The interpretation is offline and spent no additional request.

## Existing useful roles and qualification economy

The current-day R71/R72 Cohere receipt remains conclusive for Explorer, Coder, Tool Agent and Analyst. Those unchanged roles are carried without repeating the whole qualification suite. Historic positive Reviewer evidence lacking the current role protocol marker is excluded until requalified; historic hard failures remain excluded. Transient retries are archived independently and cannot erase a conclusive active receipt. Memory reads/saves are defensive copies; SQLite history survives restart.

The BlockRun model emitted a genuine exact-model native `read_file` call executed against `blockrun-tool-fixture/src/retry.mjs`. However, tool-result continuation ignored the observation or repeated a raw instruction. It is **not** qualified as Tool Agent or Coder. Reviewer qualification supplied the code/diff directly and required no tools, matching that role protocol. Provider availability is intermittent: an unavailable current catalog closes dispatch even while its qualification receipt remains valid.

Qualification requests are reported separately from autonomous coding task requests in the reliability report. A catalog, successful ping, native tool emission, probation verdict or transient failed attempt is never counted as a completed coding task.

Current exact accounting is 88 qualification/supply inference requests (62 Kilo, 26 BlockRun), distinct from the 116 external task-campaign frames. The V3 BlockRun Reviewer receipt is historical under V4; there is currently no Reviewer-qualified model under the active protocol. No new unpaid account model, personal paid model, Coder or Tool Agent promotion was fabricated. Official OpenRouter metadata observed 469 catalog rows but qualified zero models. The optional account qualification UI is not itself a measured model qualification.

Current role qualification and account/routing regressions passed 231/231 using fixtures, and billing/estimate/paid-qualification tests passed 50/50. Final account/provider transport regressions previously passed 393/393 using deterministic fixture responses, with zero external calls. The desktop now provides a separately authorized paid-model qualification workflow with visible estimates, but no actual paid qualification or paid inference was run. New anonymous V4 calls were only the two bounded public-fixture qualifications above; no coding task or parent attempt was added.
