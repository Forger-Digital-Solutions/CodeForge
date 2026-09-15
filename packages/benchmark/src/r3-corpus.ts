/**
 * R3 Benchmark Corpus — Frozen Task Definitions (100 tasks)
 * Frozen at: 2026-09-15T03:10:00Z
 */

export type DifficultyClass = 'simple' | 'normal' | 'complex' | 'adversarial';
export type OracleType = 'test_suite' | 'typecheck' | 'lint' | 'exact_output' | 'file_exists' | 'human_review' | 'no_regression';
export type TopologyPolicy = 'adaptive' | 'fixed_r1' | 'tiny' | 'normal' | 'complex' | 'single_agent';

export interface R3Task {
  id: string;
  difficulty: DifficultyClass;
  repo: string;
  startingCommit: string;
  userRequest: string;
  expectedOutcome: string;
  oracle: OracleType[];
  oracleCommand?: string;
  topologyPolicy: TopologyPolicy;
  allowedTools: string[];
  constraints: string[];
  tags: string[];
}

const SANDBOX = 'G:/dogfood/sandbox-repo';
const SANDBOX_HEAD = 'd45db35';
const DOGFOOD = 'G:/dogfood/codeforge-dogfood';
const DOGFOOD_HEAD = 'ef6b6d4';
const CODEFORGE = 'G:/CodeForge';
const CF_HEAD = '850513c';

// 20 simple + 35 normal + 30 complex + 15 adversarial = 100 tasks
// Full definitions in docs/r3-corpus-full.md
export const CORPUS_SUMMARY = {
  total: 100,
  simple: 20,
  normal: 35,
  complex: 30,
  adversarial: 15,
  repos: [SANDBOX, DOGFOOD, CODEFORGE],
  frozenAt: '2026-09-15T03:10:00Z',
  headCommits: { sandbox: SANDBOX_HEAD, dogfood: DOGFOOD_HEAD, codeforge: CF_HEAD },
} as const;

function createSimpleTasks(): R3Task[] {
  const tasks: R3Task[] = [];
  const simpleDefs = [
    { id: "S-001", req: "Fix add function to handle negative numbers properly", outcome: "add(-2, 5) returns 3", cmd: "npm test" },
    { id: "S-002", req: "Implement multiply function in src/math.js", outcome: "multiply(6, 7) returns 42", cmd: "npm test" },
    { id: "S-003", req: "Implement divide function in src/math.js with zero check", outcome: "divide(10, 2) returns 5, divide(5, 0) throws", cmd: "npm test" },
    { id: "S-004", req: "Implement subtract function in src/math.js", outcome: "subtract(10, 4) returns 6", cmd: "npm test" },
    { id: "S-005", req: "Implement power function in src/math.js", outcome: "power(2, 3) returns 8", cmd: "npm test" },
    { id: "S-006", req: "Implement sqrt function in src/math.js with negative check", outcome: "sqrt(16) returns 4", cmd: "npm test" },
    { id: "S-007", req: "Implement modulo function in src/math.js", outcome: "modulo(10, 3) returns 1", cmd: "npm test" },
    { id: "S-008", req: "Implement abs function in src/math.js", outcome: "abs(-5) returns 5", cmd: "npm test" },
    { id: "S-009", req: "Implement round function with decimal precision in src/math.js", outcome: "round(3.14159, 2) returns 3.14", cmd: "npm test" },
    { id: "S-010", req: "Implement clamp function in src/math.js", outcome: "clamp(15, 0, 10) returns 10", cmd: "npm test" },
    { id: "S-011", req: "Implement formatCurrency utility in src/format.js", outcome: "formatCurrency(1234.56, 'USD') returns $1,234.56", cmd: "npm test" },
    { id: "S-012", req: "Implement formatPercent utility in src/format.js", outcome: "formatPercent(0.856, 1) returns 85.6%", cmd: "npm test" },
    { id: "S-013", req: "Implement mean calculation in src/stats.js", outcome: "mean([1, 2, 3, 4, 5]) returns 3", cmd: "npm test" },
    { id: "S-014", req: "Implement median calculation in src/stats.js", outcome: "median([1, 3, 2]) returns 2", cmd: "npm test" },
    { id: "S-015", req: "Implement mode calculation in src/stats.js", outcome: "mode([1, 2, 2, 3]) returns 2", cmd: "npm test" },
    { id: "S-016", req: "Implement standardDeviation calculation in src/stats.js", outcome: "standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]) returns 2", cmd: "npm test" },
    { id: "S-017", req: "Export all math, format, and stats functions from src/index.js", outcome: "All functions exported", cmd: "npm test" },
    { id: "S-018", req: "Update README.md with function documentation and examples", outcome: "README documents public API", cmd: "npm test" },
    { id: "S-019", req: "Add JSDoc type annotations across src/math.js", outcome: "JSDoc comments added without breaking runtime", cmd: "npm test" },
    { id: "S-020", req: "Add edge-case unit tests in test/math.test.js for boundary inputs", outcome: "Boundary tests pass", cmd: "npm test" },
  ];

  for (const def of simpleDefs) {
    tasks.push({
      id: def.id,
      difficulty: "simple",
      repo: SANDBOX,
      startingCommit: SANDBOX_HEAD,
      userRequest: def.req,
      expectedOutcome: def.outcome,
      oracle: ["test_suite", "no_regression"],
      oracleCommand: def.cmd,
      topologyPolicy: "adaptive",
      allowedTools: ["read_file", "edit_file", "write_file", "run_command"],
      constraints: ["Zero-billing free models only", "All tests must pass", "No double writes"],
      tags: ["math", "simple", "dogfood"],
    });
  }
  return tasks;
}

function createNormalTasks(): R3Task[] {
  const tasks: R3Task[] = [];
  const normalDefs = [
    { id: "N-001", repo: SANDBOX, req: "Refactor error handling in src/math.js to use custom MathError class", outcome: "MathError thrown on invalid inputs", cmd: "npm test" },
    { id: "N-002", repo: SANDBOX, req: "Implement vector operations (dotProduct, magnitude, normalize) in src/vector.js", outcome: "Vector module with tests", cmd: "npm test" },
    { id: "N-003", repo: SANDBOX, req: "Implement matrix addition and multiplication in src/matrix.js", outcome: "Matrix module with tests", cmd: "npm test" },
    { id: "N-004", repo: SANDBOX, req: "Add validation middleware for numeric array inputs in src/validation.js", outcome: "Validator validates arrays", cmd: "npm test" },
    { id: "N-005", repo: SANDBOX, req: "Implement batch math pipeline with fluent chaining API in src/pipeline.js", outcome: "Fluent pipeline with tests", cmd: "npm test" },
    { id: "N-006", repo: SANDBOX, req: "Implement memoization wrapper for expensive math calculations in src/memo.js", outcome: "Memoized calculations pass", cmd: "npm test" },
    { id: "N-007", repo: SANDBOX, req: "Implement unit conversion utility (temp, length, mass) in src/units.js", outcome: "Units module with tests", cmd: "npm test" },
    { id: "N-008", repo: SANDBOX, req: "Add benchmark timing harness in src/benchmark.js", outcome: "Benchmark runner passes", cmd: "npm test" },
    { id: "N-009", repo: SANDBOX, req: "Implement complex number operations in src/complex.js", outcome: "Complex numbers with tests", cmd: "npm test" },
    { id: "N-010", repo: SANDBOX, req: "Implement numerical root finder using Newton-Raphson in src/roots.js", outcome: "Root finder passes tests", cmd: "npm test" },
    { id: "N-011", repo: DOGFOOD, req: "Implement workspace event emitter adapter for telemetry", outcome: "Workspace events emitted cleanly", cmd: "npm test" },
    { id: "N-012", repo: DOGFOOD, req: "Add config schema validator with Zod in packages/config", outcome: "Config schema validator passes", cmd: "npm test" },
    { id: "N-013", repo: DOGFOOD, req: "Implement secret redaction for API keys in logs and errors", outcome: "Secrets redacted from output", cmd: "npm test" },
    { id: "N-014", repo: DOGFOOD, req: "Implement session serialization and deserialization in packages/sessions", outcome: "Session state roundtrips", cmd: "npm test" },
    { id: "N-015", repo: DOGFOOD, req: "Implement JSONL transcript reader and parser", outcome: "JSONL parser extracts records", cmd: "npm test" },
    { id: "N-016", repo: DOGFOOD, req: "Add error code normalization utility for HTTP status codes", outcome: "HTTP errors mapped to codes", cmd: "npm test" },
    { id: "N-017", repo: DOGFOOD, req: "Implement tiebreaker algorithm for model ranking", outcome: "Stable deterministic ranking", cmd: "npm test" },
    { id: "N-018", repo: DOGFOOD, req: "Implement prompt token estimator utility", outcome: "Accurate token estimation", cmd: "npm test" },
    { id: "N-019", repo: DOGFOOD, req: "Implement rate-limit reset header parser (s, ms, m, ISO date)", outcome: "Reset headers parsed to ms", cmd: "npm test" },
    { id: "N-020", repo: DOGFOOD, req: "Implement approval policy checker for file mutation tools", outcome: "Mutations checked for approval", cmd: "npm test" },
    { id: "N-021", repo: DOGFOOD, req: "Implement checkpoint indexer in checkpoint service", outcome: "Checkpoints indexed by session", cmd: "npm test" },
    { id: "N-022", repo: DOGFOOD, req: "Implement git unified diff parser and formatter", outcome: "Unified diffs parsed to chunks", cmd: "npm test" },
    { id: "N-023", repo: DOGFOOD, req: "Implement topological task graph DAG sorter with cycle detection", outcome: "Task DAG topologically sorted", cmd: "npm test" },
    { id: "N-024", repo: DOGFOOD, req: "Implement worktree write lease manager with expiry", outcome: "Worktree write lease enforced", cmd: "npm test" },
    { id: "N-025", repo: DOGFOOD, req: "Implement task capsule digest generator with SHA-256", outcome: "Task capsules digested", cmd: "npm test" },
    { id: "N-026", repo: CODEFORGE, req: "Implement model capability filter for tool-calling models", outcome: "Tool models filtered accurately", cmd: "npm test" },
    { id: "N-027", repo: CODEFORGE, req: "Implement prompt cache capability resolver", outcome: "Cache capabilities classified", cmd: "npm test" },
    { id: "N-028", repo: CODEFORGE, req: "Implement SHA-256 hash helper with hex and base64 output", outcome: "Hashing helper passes unit tests", cmd: "npm test" },
    { id: "N-029", repo: CODEFORGE, req: "Implement environment sanitizer for spawned child processes", outcome: "Sanitized env filters secrets", cmd: "npm test" },
    { id: "N-030", repo: CODEFORGE, req: "Export standard error codes from @codeforge/agent", outcome: "Standard error codes exported", cmd: "npm test" },
    { id: "N-031", repo: CODEFORGE, req: "Implement semver version comparison utility", outcome: "Semver comparison passes tests", cmd: "npm test" },
    { id: "N-032", repo: CODEFORGE, req: "Implement POSIX path normalizer for cross-platform Windows compatibility", outcome: "Paths normalized to forward slash", cmd: "npm test" },
    { id: "N-033", repo: CODEFORGE, req: "Implement event store event filter by type and timestamp range", outcome: "Event store filters events", cmd: "npm test" },
    { id: "N-034", repo: CODEFORGE, req: "Implement structured finding validator for code reviewer findings", outcome: "Findings validated against schema", cmd: "npm test" },
    { id: "N-035", repo: CODEFORGE, req: "Implement token bucket sliding window pruner in governor", outcome: "History pruned beyond 60s", cmd: "npm test" },
  ];

  for (const def of normalDefs) {
    tasks.push({
      id: def.id,
      difficulty: "normal",
      repo: def.repo,
      startingCommit: def.repo === SANDBOX ? SANDBOX_HEAD : def.repo === DOGFOOD ? DOGFOOD_HEAD : CF_HEAD,
      userRequest: def.req,
      expectedOutcome: def.outcome,
      oracle: ["test_suite", "typecheck", "no_regression"],
      oracleCommand: def.cmd,
      topologyPolicy: "adaptive",
      allowedTools: ["read_file", "edit_file", "write_file", "list_files", "run_command", "search_files"],
      constraints: ["Zero-billing free models only", "Strict ESM types", "No silent corruptions"],
      tags: ["normal", "refactor", "feature"],
    });
  }
  return tasks;
}

function createComplexTasks(): R3Task[] {
  const tasks: R3Task[] = [];
  const complexDefs = [
    { id: "C-001", repo: SANDBOX, req: "Implement symbolic polynomial algebra engine with differentiation and integration", outcome: "Polynomial algebra engine passes tests", cmd: "npm test" },
    { id: "C-002", repo: SANDBOX, req: "Implement numerical Runge-Kutta 4th order ODE solver", outcome: "ODE solver passes tests", cmd: "npm test" },
    { id: "C-003", repo: SANDBOX, req: "Implement statistical distribution suite (normal, poisson, binomial, exponential)", outcome: "Distributions with CDF/PDF pass tests", cmd: "npm test" },
    { id: "C-004", repo: SANDBOX, req: "Implement Gaussian elimination matrix solver with partial pivoting", outcome: "Matrix solver passes tests", cmd: "npm test" },
    { id: "C-005", repo: SANDBOX, req: "Implement multidimensional linear regression with R-squared and p-values", outcome: "Linear regression passes tests", cmd: "npm test" },
    { id: "C-006", repo: SANDBOX, req: "Implement mathematical expression tokenizer and Shunting-Yard AST parser", outcome: "Expression parser passes tests", cmd: "npm test" },
    { id: "C-007", repo: SANDBOX, req: "Implement graph cycle detection and topological sorting engine with DAG validation", outcome: "Graph engine passes tests", cmd: "npm test" },
    { id: "C-008", repo: SANDBOX, req: "Implement fast Fourier transform (FFT) algorithm in src/fft.js", outcome: "FFT passes tests", cmd: "npm test" },
    { id: "C-009", repo: SANDBOX, req: "Implement simplex algorithm for linear programming optimization", outcome: "Simplex optimizer passes tests", cmd: "npm test" },
    { id: "C-010", repo: SANDBOX, req: "Implement geometric collision detection (AABB, SAT, Ray-Box) in src/geometry.js", outcome: "Geometry engine passes tests", cmd: "npm test" },
    { id: "C-011", repo: DOGFOOD, req: "Implement multi-subagent exploration pipeline with parallel file mapping", outcome: "Explorers map concurrently", cmd: "npm test" },
    { id: "C-012", repo: DOGFOOD, req: "Implement dual-workstream worktree isolation with atomic merge", outcome: "Dual workstreams merge cleanly", cmd: "npm test" },
    { id: "C-013", repo: DOGFOOD, req: "Implement durable checkpoint rollback recovery on verification failure", outcome: "Checkpoint rollback verified", cmd: "npm test" },
    { id: "C-014", repo: DOGFOOD, req: "Implement exactly-once tool execution replay supervisor across process restarts", outcome: "Durable replay verified", cmd: "npm test" },
    { id: "C-015", repo: DOGFOOD, req: "Implement parallel subagent dispatch with concurrency limits in SubagentManager", outcome: "Subagent dispatch paced", cmd: "npm test" },
    { id: "C-016", repo: DOGFOOD, req: "Implement dynamic 429 rate limit backoff and alternate provider failover", outcome: "429 backoff and failover pass", cmd: "npm test" },
    { id: "C-017", repo: DOGFOOD, req: "Implement multi-package dependency resolver for npm monorepos", outcome: "Monorepo dependency graph verified", cmd: "npm test" },
    { id: "C-018", repo: DOGFOOD, req: "Implement three-way git merge conflict detector for autonomous worktrees", outcome: "Conflict detector passes tests", cmd: "npm test" },
    { id: "C-019", repo: DOGFOOD, req: "Implement memory-bounded file chunking and streaming artifact persistence", outcome: "Chunked artifact persistence verified", cmd: "npm test" },
    { id: "C-020", repo: DOGFOOD, req: "Implement session snapshot exporter with verified tamper-proof digests", outcome: "Session snapshot passes verification", cmd: "npm test" },
    { id: "C-021", repo: CODEFORGE, req: "Implement ForgeVerify test gate with exit-code verification and output capture", outcome: "ForgeVerify gate verified", cmd: "npm test" },
    { id: "C-022", repo: CODEFORGE, req: "Implement completion gate authority (evaluateCompletion) with strict criteria", outcome: "Completion gate passes tests", cmd: "npm test" },
    { id: "C-023", repo: CODEFORGE, req: "Implement sliding-window token and request pacing in ProviderCapacityGovernor", outcome: "Capacity governor paces requests", cmd: "npm test" },
    { id: "C-024", repo: CODEFORGE, req: "Implement zero-cost model eligibility filter and paid-tier fail-closed gate", outcome: "Paid models strictly rejected", cmd: "npm test" },
    { id: "C-025", repo: CODEFORGE, req: "Implement prompt cache telemetry attribution with hit/miss classification", outcome: "Prompt cache savings verified", cmd: "npm test" },
    { id: "C-026", repo: CODEFORGE, req: "Implement crash recovery state classifier (safe_to_retry, replan, blocked)", outcome: "Recovery classification verified", cmd: "npm test" },
    { id: "C-027", repo: CODEFORGE, req: "Implement adversarial prompt injection sanitizer for untrusted repository files", outcome: "Prompt injection filtered", cmd: "npm test" },
    { id: "C-028", repo: CODEFORGE, req: "Implement multi-agent consensus reviewer with blocking finding threshold", outcome: "Reviewer consensus verified", cmd: "npm test" },
    { id: "C-029", repo: CODEFORGE, req: "Implement adaptive model router with dynamic capability scoring", outcome: "Adaptive router passes tests", cmd: "npm test" },
    { id: "C-030", repo: CODEFORGE, req: "Implement end-to-end autonomous engineering pipeline with full verification", outcome: "Autonomous pipeline completes and verifies", cmd: "npm test" },
  ];

  for (const def of complexDefs) {
    tasks.push({
      id: def.id,
      difficulty: "complex",
      repo: def.repo,
      startingCommit: def.repo === SANDBOX ? SANDBOX_HEAD : def.repo === DOGFOOD ? DOGFOOD_HEAD : CF_HEAD,
      userRequest: def.req,
      expectedOutcome: def.outcome,
      oracle: ["test_suite", "typecheck", "no_regression"],
      oracleCommand: def.cmd,
      topologyPolicy: "complex",
      allowedTools: ["read_file", "edit_file", "write_file", "list_files", "run_command", "search_files", "repo_search", "repo_symbol"],
      constraints: ["Zero-billing free models only", "Fail closed on verification failure", "No false completions"],
      tags: ["complex", "architecture", "multi-agent"],
    });
  }
  return tasks;
}

function createAdversarialTasks(): R3Task[] {
  return [
    {
      id: "A-001",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Crash injection before first model call: runtime must restart and complete without duplicate work",
      expectedOutcome: "Crash before first call resumes safely and completes",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/run-recovery.test.ts",
      topologyPolicy: "fixed_r1",
      allowedTools: ["read_file", "write_file", "edit_file", "run_command"],
      constraints: ["100% crash recovery safety", "0 double writes", "0 false completions"],
      tags: ["adversarial", "crash-recovery", "safety"],
    },
    {
      id: "A-002",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Crash injection after real file write: runtime must not re-execute write on resume",
      expectedOutcome: "No duplicate write after restart",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/run-recovery.test.ts",
      topologyPolicy: "fixed_r1",
      allowedTools: ["read_file", "write_file", "edit_file", "run_command"],
      constraints: ["0 double writes", "Durable tool journal state verified"],
      tags: ["adversarial", "crash-recovery", "idempotency"],
    },
    {
      id: "A-003",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Crash with unobserved read-only tool call: tool must be replayed exactly once",
      expectedOutcome: "Unobserved read-only tool replayed once safely",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/run-recovery.test.ts",
      topologyPolicy: "fixed_r1",
      allowedTools: ["read_file", "write_file", "run_command"],
      constraints: ["Read-only idempotency verified", "0 corruption"],
      tags: ["adversarial", "crash-recovery", "read-only"],
    },
    {
      id: "A-004",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Crash with unobserved mutating write: runtime must replan honestly and never re-execute",
      expectedOutcome: "Unobserved mutating write triggers replan and never duplicates",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/run-recovery.test.ts",
      topologyPolicy: "fixed_r1",
      allowedTools: ["read_file", "write_file", "edit_file", "run_command"],
      constraints: ["Mutating writes never duplicated blindly", "Safe replanning required"],
      tags: ["adversarial", "crash-recovery", "replan"],
    },
    {
      id: "A-005",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Crash with unobserved command execution: runtime must replan and never blind retry",
      expectedOutcome: "Unobserved command converges honestly through replan",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/run-recovery.test.ts",
      topologyPolicy: "fixed_r1",
      allowedTools: ["read_file", "run_command"],
      constraints: ["Command execution safety", "0 blind retries"],
      tags: ["adversarial", "crash-recovery", "command-safety"],
    },
    {
      id: "A-006",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Reviewer killed mid-run: resumes and still fails closed when verdict blocks",
      expectedOutcome: "Reviewer verdict blocks run honestly on failure",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/run-recovery.test.ts",
      topologyPolicy: "fixed_r1",
      allowedTools: ["read_file", "run_command"],
      constraints: ["Fail closed on blocking review findings", "0 false approvals"],
      tags: ["adversarial", "reviewer-gate", "safety"],
    },
    {
      id: "A-007",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Upstream provider 429 rate limit backoff: governor paces and routes to alternate provider",
      expectedOutcome: "Provider 429 backoff observed and alternate free provider selected",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/multi-subagent-concurrency.test.ts",
      topologyPolicy: "adaptive",
      allowedTools: ["read_file", "run_command"],
      constraints: ["Dynamic 429 cooldown honored", "Zero paid model fallback"],
      tags: ["adversarial", "rate-limit", "capacity-governor"],
    },
    {
      id: "A-008",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Malformed model structured output wrapped in markdown fences: tolerantly decodes JSON",
      expectedOutcome: "Markdown-fenced JSON decoded cleanly without blocking run",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/subagents.test.ts",
      topologyPolicy: "adaptive",
      allowedTools: ["read_file", "run_command"],
      constraints: ["Strict schema validation preserved", "Tolerant markdown code fence stripping"],
      tags: ["adversarial", "structured-output", "robustness"],
    },
    {
      id: "A-009",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Invalid exact-model selection requested: fail closed with PROVIDER_MODEL_UNAVAILABLE",
      expectedOutcome: "Exact model failure throws PROVIDER_MODEL_UNAVAILABLE, never silently substitutes",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/multi-subagent-concurrency.test.ts",
      topologyPolicy: "single_agent",
      allowedTools: ["read_file"],
      constraints: ["Exact model preservation", "Fail closed"],
      tags: ["adversarial", "firewall", "exact-model"],
    },
    {
      id: "A-010",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "No eligible models available: reject legacy fallback to modelId: 'default'",
      expectedOutcome: "Throws PROVIDER_MODEL_UNAVAILABLE, never fabricates 'default' modelId",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/multi-subagent-concurrency.test.ts",
      topologyPolicy: "adaptive",
      allowedTools: ["read_file"],
      constraints: ["Zero-billing firewall guarantee", "No fake provider model IDs"],
      tags: ["adversarial", "firewall", "zero-cost"],
    },
    {
      id: "A-011",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Provider capacity governor queue depth exceeded: throws PROVIDER_CAPACITY_EXCEEDED",
      expectedOutcome: "Rejects with PROVIDER_CAPACITY_EXCEEDED when queue depth limit reached",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/providers/test/capacity-governor.test.ts",
      topologyPolicy: "adaptive",
      allowedTools: ["read_file"],
      constraints: ["Deterministic queue depth rejection", "No memory leak"],
      tags: ["adversarial", "capacity-governor", "queue-depth"],
    },
    {
      id: "A-012",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "AbortSignal cancellation during queue wait: tokens released, zero phantom reservations",
      expectedOutcome: "Cancelled queue request frees in-flight reservation cleanly",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/providers/test/capacity-governor.test.ts",
      topologyPolicy: "adaptive",
      allowedTools: ["read_file"],
      constraints: ["Clean cancellation", "Zero token leak"],
      tags: ["adversarial", "cancellation", "capacity-governor"],
    },
    {
      id: "A-013",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Server restart with running subagents: stale workers reconciled to honest failed status",
      expectedOutcome: "Interrupted workers reconciled to failed status with reason",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/subagents.test.ts",
      topologyPolicy: "fixed_r1",
      allowedTools: ["read_file"],
      constraints: ["Honest status convergence", "0 phantom running workers"],
      tags: ["adversarial", "stale-worker", "crash-recovery"],
    },
    {
      id: "A-014",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Agent tool loop detected: identical repeated actions trigger loop detection escalation",
      expectedOutcome: "Tool loop detected and terminated without infinite spin",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/server/test/agent-tool-loop.test.ts",
      topologyPolicy: "adaptive",
      allowedTools: ["read_file", "search_files"],
      constraints: ["Loop detection enforced", "Bounded budget execution"],
      tags: ["adversarial", "tool-loop", "budget"],
    },
    {
      id: "A-015",
      difficulty: "adversarial",
      repo: CODEFORGE,
      startingCommit: CF_HEAD,
      userRequest: "Unverified run claims completion: evaluateCompletion gate rejects and terminates blocked",
      expectedOutcome: "Run terminates blocked; completion never asserted without verification pass",
      oracle: ["test_suite", "no_regression"],
      oracleCommand: "npx vitest run packages/workflow/test/completion-gate.test.ts",
      topologyPolicy: "adaptive",
      allowedTools: ["read_file", "write_file"],
      constraints: ["Completion gate is sole authority", "Blocked state is terminal non-success"],
      tags: ["adversarial", "completion-gate", "enforcement"],
    },
  ];
}

export const R3_TASKS: R3Task[] = [
  ...createSimpleTasks(),
  ...createNormalTasks(),
  ...createComplexTasks(),
  ...createAdversarialTasks(),
];
