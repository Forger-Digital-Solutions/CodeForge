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
