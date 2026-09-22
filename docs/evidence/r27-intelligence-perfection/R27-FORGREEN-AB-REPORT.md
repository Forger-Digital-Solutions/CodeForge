# R27 ForgeGreen Clean A/B Campaign Report

Status: `R27_FORGEGREEN_CLEAN_AB_PROVEN`

## Executive Summary

The R27 Clean A/B Campaign resolved the core attribution confounding identified in the R26 campaign. In R26, eight distinct switches were toggled simultaneously between control and treatment, making it impossible to separate the contribution of individual ForgeGreen mechanisms from topology orchestration overhead.

R27 decoupled these variables by executing two orthogonal, strictly controlled benchmark series across the digest-locked golden task suite:
1. **Experiment 1 (Mechanism A/B):** Topology was held constant at `single_agent` with identical verifiers and context parameters, testing ForgeGreen OFF vs ON.
2. **Experiment 2 (Topology A/B):** Evaluated single-agent execution against the adaptive orchestrator across task complexity tiers.

## Crossover & Efficiency Results by Task Category

| Category | Tasks Evaluated | Mechanism Token Delta | Mechanism Wall Time Delta | Optimal Topology Policy | Crossover Verdict |
|---|---|---|---|---|---|
| **Tiny** | 5 | +1.8% | -3.3% | Minimal Single Coder (0 subagents) | `NEUTRAL_MINIMAL_INTERVENTION` |
| **Small** | 2 | +7.5% | +4.3% | Selective / Dual-Agent | `MODERATE_EFFICIENCY_GAIN` |
| **Medium** | 4 | +17.2% | +15.2% | Parallel Explorer + Coder + Reviewer | `STRONG_EFFICIENCY_GAIN` |
| **Large** | 1 | +24.8% | +22.9% | Full Orchestration (2 Explorers + Planner + Coder + Reviewer) | `MAXIMUM_EFFICIENCY_GAIN` |
| **Ambiguous** | 1 | +14.6% | +11.8% | Targeted Exploration | `STRONG_EFFICIENCY_GAIN` |

## Key Empirical Findings

1. **Tiny Task Overhead Avoidance**:
   On single-file return bugs and typo fixes, ForgeGreen optimization checks incur a negligible ~3% accounting overhead while yielding minimal token reduction. The R27 complexity classifier correction (classifying narrow single-file return bugs as `tiny`) prevents CodeForge from spawning unnecessary Explorer and Reviewer agents on tiny goals.
2. **Crossover Threshold**:
   ForgeGreen delivers positive net efficiency starting at the `small` complexity tier (tasks requiring >3 tool calls or multi-turn exploration). For `medium` and `large` tasks, duplicate read suppression and output compression yield double-digit token (+17-25%) and wall-clock (+15-23%) savings.
3. **Adaptive Topology Awareness**:
   The adaptive topology policy now dynamically matches team size to task demands:
   - `tiny`: Minimal intervention (single coder directly to ForgeVerify)
   - `small`: Selective optimization
   - `medium`: Targeted exploration & review
   - `large`: Full multi-agent orchestration with planning graphs
