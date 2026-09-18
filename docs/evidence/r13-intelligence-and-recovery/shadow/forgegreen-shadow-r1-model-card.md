# forgegreen-shadow-r1 model card

State: **SHADOW ONLY**

Purpose: estimate useful context scale, no-progress risk, tool effort, and possible topology value. Inputs include aggregate context, duplicate/reuse, tool, no-progress, provider-concentration, and topology signals. Priority 7 ablation evidence is represented as `SIMULATED`, never as observed production telemetry.

The candidate is the shared calibrated-linear format after the training threshold. Today it returns the static topology baseline with `INSUFFICIENT_DATA`; calibration and benchmark metrics are intentionally not claimed.

It may never change topology, spawn agents, select providers, invoke tools, reduce verification, grant permission, or determine completion. Existing ForgeGreen and ForgeVerify rules retain their authority.
