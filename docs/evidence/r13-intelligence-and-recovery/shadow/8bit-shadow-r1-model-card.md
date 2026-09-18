# 8bit-shadow-r1 model card

State: **SHADOW ONLY**

Purpose: estimate route availability risk and verified-success likelihood alongside deterministic 8-Bit selection. Inputs are sanitized task/route/context/tool and historical health bands. The deterministic health/capacity baseline is always computed first. The candidate is a calibrated linear model whose intercept is fitted only after 20 labeled training rows; its explicitly reviewed monotonic coefficients penalize rate-limit risk, quota exhaustion, context pressure, and no-progress signals.

The current shared-v1 dataset has no fitted rows, so the runtime returns the baseline with `INSUFFICIENT_DATA`. It records no raw prompt or source. Metrics therefore remain `NOT_EVALUATED`; calibration is `INSUFFICIENT_EVIDENCE`.

It may never choose a route, create eligibility, cross free/paid/BYOK boundaries, activate a provider, consume capacity, alter failover, skip ForgeVerify, or declare completion. Artifact schema mismatch, corruption, or loading failure uses the deterministic baseline and does not block routing.
