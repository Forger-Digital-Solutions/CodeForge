# 8-Bit R3.5 — Real Specialist Model: Certification Report

Campaign window: 2026-09-15/16 · Branch `forger-digital-solutions-forgegreen-certified` · Starting HEAD `461baea`

**Decision: `8BIT_EXPERIMENTAL`** — a real neural specialist was trained on GPU and evaluated with a frozen, leakage-audited protocol; it does not add measurable value over the deterministic baseline at current evidence scale, so the deterministic production system remains the routing authority and the learned artifact is experimental. Zero hard safety violations were observed in any system.

---

## Architecture

| Field | Value |
| --- | --- |
| Base model | From-scratch compact tabular feature-token transformer (no third-party weights) |
| Revision | N/A — architecture only; all weights are CodeForge-owned |
| License | CodeForge-owned (MIT-licensed repository); no external weight license applies |
| Parameter count | 345,812 |
| Architecture | Per-feature tokenization (identity embedding + value projection + learned missing-value embedding) → learned task-type token → 3-layer pre-norm Transformer encoder (d_model 96, 4 heads, FFN 384, GELU, dropout 0.15) → pooled task head (ROUTE_OUTCOME 7-way, ROLE_SUITABILITY 3-way, ECONOMICS_STATE 10-way) |
| Why chosen | The 8-Bit specialist problem at current data scale is structured tabular evidence (statuses, counters, latencies, capacity ratios), not raw text. A feature-token transformer learns cross-feature interactions (e.g. daily-budget ratio × health state) without inheriting any third-party model's license, terms or training-data obligations — which keeps the entire artifact inside CodeForge's own training-rights governance. |

## Training Environment

- GPU: **NVIDIA Quadro T2000** (Turing, compute capability 7.5, 16 SMs)
- VRAM: 4096 MB total; 3297 MB free at probe time
- Driver 610.47; CUDA runtime 12.6 (`torch 2.14.0+cu126`), cuDNN 91002
- Mixed precision: **float16** (supported by CC 7.5)
- **Peak VRAM during training: 33.8 MB** (safe peak target: 2308 MB — not exceeded)
- **No CPU fallback proof**: `scripts/eightbit-hw-probe.py` exits non-zero when CUDA is unavailable (`GPU_TRAINING_FORBIDDEN`), and `scripts/eightbit-train.py` re-verifies `torch.cuda.is_available()` and exits before touching data if absent. All tensors and optimizers were created on `device="cuda"`. The probe's allocation test (256×256 matmul on-device) passed. GPU temperature at probe: 46 °C, 11 W.

## Dataset

- **Sources (all CodeForge-owned structured evidence; provenance recorded per row):**
  - R3-RC2 frozen corpus task records (90 dispatched attempts) — `R3_CORPUS_ATTEMPT`
  - Smoke-attempt per-worker telemetry (8 workers, real Groq serving outcomes) — `R3_CORPUS_ATTEMPT`
  - Managed-free R2 fleet qualification (role statuses per route) — `QUALIFICATION_PROBE`
  - R5 live zero-unit discovery catalog (22 OpenRouter candidates) — `DISCOVERY_CATALOG`
  - Derived capacity trajectories from certified observed constants (Groq TPD 200k/TPM 8k; Cloudflare 10k neurons) — `DERIVED_SIMULATION`, train-only by construction
- **Training-rights state:** every row carries a provenance record with `TRAINING_USE_APPROVED`; no third-party model output content is embedded (structured metadata only), no credentials, no private source code, no personal data. The gate (`assertTrainingUseAllowed`) is enforced at row validation and re-enforced at split freeze; violations throw.
- **Rows:** 469 total — 69 real evidence rows (14 corpus route outcomes, 8 smoke worker outcomes, 33 role suitability, 22 economics states — some rows overlap categories by task kind, see manifest `counts.byTaskKind`) + 400 derived capacity simulations (seed 20260915, deterministic mulberry32).
- **Splits (frozen, hash-locked):** TRAIN 438 / DEV 8 / PROTECTED_HOLDOUT 3 / TEMPORAL_HOLDOUT 20.
  - Grouped by canonical model identity (`lab/slug` via the moved `canonicalIdentityFor` in `@codeforge/forge-zero`): **zero cross-split canonical-group leakage** (regression-tested).
  - Temporal holdout reserved from the newest real evidence (after 2026-09-15T22:30Z) to simulate "something changed after training".
  - Family-level overlap across splits (nemotron, laguna, gemma, nex) is **reported, not hidden** — with ~10 distinct families in the corpus, family-exclusive splitting would leave evaluation splits empty; canonical grouping is the enforced invariant.
  - Any canonical group containing a derived-simulation row moves wholly to TRAIN (keeps simulations out of evaluation without splitting a group).
- **Hashes:** dataset manifest `6e4f4c81…` (full: `tests/evidence/r3.5-8bit-dataset/manifest.json`), splits SHA-256 `6e4f4c81024b8988a172d32d214d493ed92d294ebd93e4b1dbb722638ff0418d`. Freeze discipline: re-materialization refuses to overwrite an existing frozen dataset.

## Training

- Single-stage multi-task SFT from scratch; AdamW (lr 1.2e-3, wd 0.01), batch 32, grad-clip 1.0, class-weighted cross-entropy (sqrt-inverse-frequency per task head).
- fp16 autocast + GradScaler; seeds fixed (20260915) for model init, shuffling and simulation.
- Three runs, all preserved:
  1. **run1** (`r3.5-8bit-model-v1-run1-failed-selection/`): early stopping kept epoch-0 weights because the 8-row DEV split plateaus at macro-F1 1.0 immediately — a selection-procedure artifact, disclosed and fixed.
  2. Pre-declared rule change: patience counts only after epoch 60.
  3. **Final** (`r3.5-8bit-model-v1/`): tie-keep-latest selection (most-trained epoch on the DEV plateau); ran the full 400 epochs, wall time 187 s.
- The selection-rule changes were declared against the degenerate-DEV data property only; PROTECTED_HOLDOUT and TEMPORAL_HOLDOUT were never consulted during training or selection.

## Evaluation

Per-split macro-F1 / accuracy (higher better); learned-model Brier on the temporal holdout:

| Split · Task | Deterministic | Learned | Hybrid |
| --- | --- | --- | --- |
| DEV · ROLE_SUITABILITY | acc 1.00 / F1 1.00 (n=3) | acc 1.00 / F1 1.00 | acc 1.00 / F1 1.00 |
| DEV · ECONOMICS_STATE | acc 1.00 / F1 1.00 (n=5) | acc 1.00 / F1 1.00 | acc 1.00 / F1 1.00 |
| TEMPORAL · ROUTE_OUTCOME | acc 1.00 / F1 1.00 (n=14) | **acc 0.00 / F1 0.00** | acc 0.857 / F1 0.938 |
| TEMPORAL · ROLE_SUITABILITY | acc 1.00 / F1 1.00 (n=6) | acc 0.667 / F1 0.452 | acc 1.00 / F1 1.00 |
| PROTECTED · ECONOMICS_STATE | acc 1.00 / F1 1.00 (n=3) | acc 1.00 / F1 1.00 | acc 1.00 / F1 1.00 |

- Learned Brier (TEMPORAL_HOLDOUT): **1.335** (poorly calibrated under shift). DEV/PROTECTED Brier ≈ 0 — degenerate (single-class) splits, not evidence of quality.
- Abstention: hybrid abstains to the deterministic decision when learned confidence < 0.6 or `evidenceCompleteness` < 0.5 — this is what pulled hybrid route-outcome accuracy to 0.857 under shift.
- Tool-selection / structured-call metrics: not yet evaluable — no real tool-selection traces exist yet in the corpus (windows are capacity-blocked); the schema and label spaces are in place.
- Latency: 8.5–8.9 ms single-row GPU inference; artifact 7.25 MB.
- **Critical-policy metrics: false-free classification 0, policy overrides 0, unsafe promotions 0 — in ALL three systems.** The learned model never successfully talked its way past a blocking state in evaluation.
- **Honest caveat (baseline circularity):** the corpus-derived route-outcome labels were constructed from the same observed health/failure evidence the deterministic echo reads, so the deterministic baseline's perfect temporal score is partly definitional. This does not rescue the learned model — its 0.0 temporal accuracy fails regardless — but it means the deterministic system's measured "1.0" must not be read as real-world 100% prediction.

## Shadow / Promotion Decision

- Shadow evaluation (`scripts/r35-shadow-evaluate.mjs` → `shadow-report.json`, hash-locked) ran all three systems on identical frozen rows: 16 deterministic/learned disagreements logged with confidences for future calibration.
- Hard violations (§19 gate): unsafe paid-route promotion 0; policy override 0; critical false-free 0; known blocked provider promotion 0. Private-repo prohibited-route promotion: not evaluable (no private-repo rows yet) — honestly recorded.
- `learnedAddsMeasurableValueOverDeterministic: false`.
- **Decision: `8BIT_EXPERIMENTAL`** (recorded in `registry-candidate.json` with rationale). The learned system is NOT production; it is NOT rejected — the pipeline, dataset versioning, freeze discipline, registry and rollback slots are operational, and the daily corpus windows are accumulating the real per-task evidence the next candidate needs.

## Artifact

- Path: `tests/evidence/r3.5-8bit-model-v1/8bit-r35-c1.json.pt`
- SHA-256: `4b722a5ce472d403496479f9b0841fa305dc63aa4b0003eb1f54d4b890d9b65d`
- Size: 7,564,258 bytes (weights serialized as JSON for auditability; no pickle)
- Version: `r35-c1` · promotion_state: `experimental`

## Continual Learning / Rollback

- Registry fields (`8bit_version`, dataset/split hashes, code SHA, GPU, peak VRAM, artifact SHA, `previous_version`, `rollback_target`, `promotion_state`) are populated; the schema is in `registry-candidate.json` and will be enforced by the registry module as versions accumulate.
- Rollback semantics: promotion_state transitions (`candidate → shadow → canary → production`, with `quarantined`/`rolled_back` exits) are recorded per version; this version is terminal-state `experimental` with `rollback_target: null` (nothing to roll back to — first learned artifact).
- Only verified outcomes become labels: the label sources are CodeForge's own certified verification evidence (completion-gated corpus records, live qualification receipts); a run's self-reported success is never a label. The next candidate retrains from a NEW frozen dataset version — the temporal holdout discipline prevents self-confirmation.

## What R3.6+ must add for a promotable 8-Bit

1. **Real per-task evidence at scale** — the daily corpus windows produce real outcome rows; ~200+ real route-outcome rows across providers/roles is the minimum for a distribution-shift-resistant candidate.
2. **Additional legitimate free routes qualified** — provider diversity is the strongest leakage/shift defense (see WINDOW-1-REPORT §6).
3. **A non-circular deterministic baseline** — log deterministic decisions at decision time (before outcomes exist) so the comparison is prospective, not echo-based. The shadow harness's disagreement log is the first instrument for this.
4. **Tool-use traces** — role/tool selection labels from real agent runs feed the structured-reasoning head the mandate specifies.
