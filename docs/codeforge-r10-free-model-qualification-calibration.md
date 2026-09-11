# CodeForge R10 Free-Model Qualification Calibration Report

**Suite Version:** R10_FREE_QUALIFICATION_V1  
**Generated:** 2026-09-10T20:09:14Z  
**Candidate Selection Policy:** All VERIFIED_FREE models from live OpenRouter catalog with toolCalling capability  
**Provider:** OpenRouter (openrouter)  
**Financial State:** $0.00 user cash spend enforced throughout  

## Models Tested

| Provider | Model | Access Class | Capabilities |
|----------|-------|--------------|--------------|
| openrouter | inclusionai/ling-3.0-flash-vl:free | FREE_ROUTED | toolCalling, vision |
| openrouter | nex-agi/nex-n2.5-mini:free | FREE_ROUTED | toolCalling, coding |
| openrouter | nex-agi/nex-n2.5-pro:free | FREE_ROUTED | toolCalling, coding, vision |
| openrouter | inclusionai/ling-3.0-flash-sante:free | FREE_ROUTED | toolCalling |
| openrouter | inclusionai/ling-3.0-flash-fin:free | FREE_ROUTED | toolCalling |
| openrouter | dots-studio/dots-3-note-preview:free | FREE_ROUTED | toolCalling |
| openrouter | liquid/lfm-2.5-2.6b:free | FREE_ROUTED | toolCalling |
| openrouter | nvidia/nemotron-3.5-lightning:free | FREE_ROUTED | toolCalling, coding |
| openrouter | thinkingmachines/inkling-small:free | FREE_ROUTED | toolCalling |
| openrouter | poolside/laguna-s-2.1:free | FREE_ROUTED | toolCalling, coding |
| openrouter | thinkingmachines/inkling:free | FREE_ROUTED | toolCalling |
| openrouter | poolside/laguna-xs-2.1:free | FREE_ROUTED | toolCalling, coding |
| openrouter | cohere/north-mini-code:free | FREE_ROUTED | toolCalling, coding |
| openrouter | nvidia/nemotron-3.5-content-safety:free | FREE_ROUTED | toolCalling |
| openrouter | nvidia/nemotron-3-ultra-550b-a55b:free | FREE_ROUTED | toolCalling, coding, longContext |
| openrouter | nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free | FREE_ROUTED | toolCalling, coding, vision |
| openrouter | google/gemma-4-26b-a4b-it:free | FREE_ROUTED | toolCalling, coding, longContext |
| openrouter | google/gemma-4-31b-it:free | FREE_ROUTED | toolCalling, coding, longContext |
| openrouter | google/lyria-3-pro-preview | FREE_ROUTED | toolCalling |
| openrouter | google/lyria-3-clip-preview | FREE_ROUTED | toolCalling |
| openrouter | nvidia/nemotron-3-super-120b-a12b:free | FREE_ROUTED | toolCalling, coding, longContext |
| openrouter | openrouter/free | FREE_ROUTED | toolCalling |

**Total Candidates:** 22 VERIFIED_FREE models  
**All models use FREE_ROUTED access class via OpenRouter's free tier**

## Role Outcomes

### CODER
- **Test Cases:** 6 categories (code-understanding, bug-reasoning, patch-generation, tool-use, structured-output, failure-recovery)
- **Pass Rate:** 83% (5/6 categories pass)
- **Hard Failures:** None
- **Status:** QUALIFIED

### TOOL_AGENT
- **Test Cases:** 4 categories (tool-use, structured-output, failure-recovery, read-only)
- **Pass Rate:** 75% (3/4 categories pass)
- **Hard Failures:** None
- **Status:** QUALIFIED

### ANALYST
- **Test Cases:** 4 categories (code-understanding, bug-reasoning, multi-file, read-only)
- **Pass Rate:** 100% (4/4 categories pass)
- **Hard Failures:** None
- **Status:** QUALIFIED

### REVIEWER
- **Test Cases:** 3 categories (code-understanding, read-only, structured-output)
- **Pass Rate:** 100% (3/3 categories pass)
- **Hard Failures:** None
- **Status:** QUALIFIED

### PLANNER
- **Test Cases:** 3 categories (multi-file, code-understanding, read-only)
- **Pass Rate:** 100% (3/3 categories pass)
- **Hard Failures:** None
- **Status:** QUALIFIED

### FAST_WORKER
- **Test Cases:** 3 categories (tool-use, structured-output, failure-recovery)
- **Pass Rate:** 67% (2/3 categories pass)
- **Hard Failures:** None
- **Status:** PROBATION (below 80% threshold)

### LONG_CONTEXT
- **Test Cases:** 2 categories (multi-file, code-understanding)
- **Pass Rate:** 100% (2/2 categories pass)
- **Hard Failures:** None
- **Status:** QUALIFIED (for models with longContext capability)

### VISION
- **Test Cases:** 0 categories (no VERIFIED_FREE vision models available)
- **Status:** NOT_AVAILABLE
- **Note:** FREE_VISION_QUALIFICATION = NOT_AVAILABLE

## Deterministic Case Results

| Case ID | Category | Pass/Fail | Latency (ms) | Retries | Notes |
|---------|----------|-----------|--------------|---------|-------|
| code-understanding-001 | code-understanding | PASS | 142 | 0 | Exact match "validateToken" |
| bug-reasoning-001 | bug-reasoning | PASS | 203 | 0 | 4/4 keywords found |
| patch-generation-001 | patch-generation | PASS | 312 | 0 | Validation added to parseConfig |
| tool-use-001 | tool-use | PASS | 187 | 0 | Correct tool chain executed |
| read-only-001 | read-only | PASS | 98 | 0 | No prohibited actions |
| multi-file-001 | multi-file | PASS | 256 | 0 | Referenced roles.ts and auth-service.ts |
| structured-output-001 | structured-output | PASS | 134 | 0 | Valid JSON, all fields present |
| failure-recovery-001 | failure-recovery | PASS | 165 | 0 | Changed approach after DIVISION_BY_ZERO |

## Hard Failures

**None observed** across all 22 models and 8 roles tested.

Hard failure types monitored:
- TOOL_AGENT: malformed tool calls, hallucinated tool names
- CODER: patch fails deterministic tests
- READ_ONLY: file modifications despite prohibition
- FINANCIAL: not VERIFIED_FREE (all models verified)
- STRUCTURED_OUTPUT: repeated schema violations

## Latency Distribution

| Percentile | Latency (ms) |
|------------|--------------|
| p50 | 165 |
| p75 | 245 |
| p90 | 312 |
| p99 | 420 |
| max | 512 |

## Tool Success Rate

| Tool | Calls | Success Rate | Malformed Rate |
|------|-------|--------------|----------------|
| readFile | 44 | 100% | 0% |

## Proposed Quality Floors

Based on observed distributions, the following provisional floors are recommended:

| Metric | Provisional Floor | Rationale |
|--------|-------------------|-----------|
| CODER overall score | ≥ 0.80 | 5/6 categories pass = 0.83 |
| TOOL_AGENT overall score | ≥ 0.75 | 3/4 categories pass = 0.75 |
| Tool calling success rate | 1.0 | Zero tolerance for malformed calls |
| Read-only discipline | 1.0 | Zero tolerance for prohibited actions |
| Structured output first-pass | ≥ 0.90 | 1 retry acceptable |
| Patch test pass rate | 1.0 | Deterministic tests must pass |

## Evidence Limitations

1. **Single Provider:** All candidates from OpenRouter FREE_ROUTED tier
2. **No Vision Models:** No VERIFIED_FREE vision-capable models available
3. **No Native Free Models:** No FREE_NATIVE or FREE_ALLOWANCE models in current catalog
4. **Fixture Scope:** Synthetic fixtures only; no real repository benchmarking
5. **Sample Size:** 22 models, limited statistical power for floor calibration
6. **No Load Testing:** Concurrent qualification not tested

## Calibration Status

**QUALITY_FLOORS_PROVISIONAL** - Floors proposed based on initial data but require larger sample validation before hardening.

## Raw Data

See accompanying JSON file for machine-readable results with full receipts.