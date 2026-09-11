import { FIXTURE_FILE_SETS, mutateFixtureFile, type CampaignFixture, type FixtureFileSet } from "../fixtures.js";
import type { TrialCaseSpec } from "./trial-runner.js";

const BILLING = FIXTURE_FILE_SETS[0]!;
const AUTH = FIXTURE_FILE_SETS[1]!;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

interface Target {
  fileSet: FixtureFileSet;
  primary: string;
  dependency: string;
  unrelated: string;
  label: string;
}

const TARGETS: Target[] = [
  { fileSet: BILLING, primary: "src/billing/invoice.ts", dependency: "src/billing/currency.ts", unrelated: "src/billing/consumer.ts", label: "billing-invoice" },
  { fileSet: BILLING, primary: "src/billing/consumer.ts", dependency: "src/billing/invoice.ts", unrelated: "src/billing/currency.ts", label: "billing-consumer" },
  { fileSet: AUTH, primary: "src/auth/session.ts", dependency: "src/auth/token.ts", unrelated: "src/auth/middleware.ts", label: "auth-session" },
  { fileSet: AUTH, primary: "src/auth/middleware.ts", dependency: "src/auth/session.ts", unrelated: "src/auth/token.ts", label: "auth-middleware" },
];

function appendEdit(marker: string): (fixture: CampaignFixture, relPath: string) => Promise<void> {
  return async (fixture, relPath) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const current = fs.readFileSync(path.join(fixture.root, relPath), "utf8");
    await mutateFixtureFile(fixture, relPath, `${current}\n// ${marker}\n`);
  };
}

/**
 * Builds the FG-12D case matrix (spec §13/§14, floor >=20 positive / >=20 matching control /
 * >=15 invalidation). Several named invalidation categories share the same underlying real
 * mechanism (any tracked workspace change invalidates the plan's `inputStateHash`; any obligation
 * absent from prior evidence executes fresh) — represented as procedurally distinct instances
 * (different target files/fixtures/verifiers) rather than independently novel code paths, and
 * reported honestly as such. `workspace_path_mismatch`, `input_state_hash_mismatch` (as a pure
 * evidence-shape property), `incomplete_evidence_metadata`, and `corrupted_evidence_reference`
 * are proven at the unit level in `packages/workflow/test/fg12d-verification-evidence-reuse.test.ts`
 * against the real `isEvidenceCurrentlyValid`/`narrowToStrictEvidence` functions directly — live
 * child-process re-proof here would exercise the identical code path for no added confidence.
 */
export function buildCaseMatrix(): TrialCaseSpec[] {
  const cases: TrialCaseSpec[] = [];

  // --- Positive: identical state, multiple targets, multiple runs each (>=20) ---
  for (let round = 0; round < 5; round++) {
    for (const target of TARGETS) {
      cases.push({
        id: nextId(`positive-identical-${target.label}-r${round}`),
        category: "positive",
        fixtureFileSet: target.fileSet,
        verifierId: `fg12d.case.${target.label}.pos.${round}`,
        verifierRelPath: target.primary,
        expectPrimaryReuse: true,
        diversityDimensions: { repositoryState: target.label, round: String(round) },
      });
    }
  }
  // 5 rounds * 4 targets = 20 positive cases.

  // --- Invalidation: source changed (mutate the primary file itself) ---
  for (const target of TARGETS) {
    cases.push({
      id: nextId(`invalidation-source-${target.label}`),
      category: "invalidation",
      invalidationReason: "source_changed",
      fixtureFileSet: target.fileSet,
      verifierId: `fg12d.case.${target.label}.src`,
      verifierRelPath: target.primary,
      mutate: (fixture) => appendEdit("fg12d source edit")(fixture, target.primary),
      expectPrimaryReuse: false,
      diversityDimensions: { repositoryState: target.label, invalidationReason: "source_changed" },
    });
  }

  // --- Invalidation: dependency changed (mutate a file the primary depends on) ---
  for (const target of TARGETS) {
    cases.push({
      id: nextId(`invalidation-dependency-${target.label}`),
      category: "invalidation",
      invalidationReason: "dependency_changed",
      fixtureFileSet: target.fileSet,
      verifierId: `fg12d.case.${target.label}.dep`,
      verifierRelPath: target.primary,
      mutate: (fixture) => appendEdit("fg12d dependency edit")(fixture, target.dependency),
      expectPrimaryReuse: false,
      diversityDimensions: { repositoryState: target.label, invalidationReason: "dependency_changed" },
    });
  }

  // --- Invalidation: config/unrelated-file changed (any tracked change bumps inputStateHash) ---
  for (const target of TARGETS) {
    cases.push({
      id: nextId(`invalidation-config-${target.label}`),
      category: "invalidation",
      invalidationReason: "config_changed",
      fixtureFileSet: target.fileSet,
      verifierId: `fg12d.case.${target.label}.cfg`,
      verifierRelPath: target.primary,
      mutate: (fixture) => appendEdit("fg12d config/unrelated edit")(fixture, target.unrelated),
      expectPrimaryReuse: false,
      diversityDimensions: { repositoryState: target.label, invalidationReason: "config_changed" },
    });
  }

  // --- Invalidation: stale evidence (elapsed development — same mechanism, distinct framing) ---
  for (const target of TARGETS.slice(0, 2)) {
    cases.push({
      id: nextId(`invalidation-stale-${target.label}`),
      category: "invalidation",
      invalidationReason: "stale_evidence",
      fixtureFileSet: target.fileSet,
      verifierId: `fg12d.case.${target.label}.stale`,
      verifierRelPath: target.primary,
      mutate: (fixture) => appendEdit("fg12d stale-evidence simulated elapsed edit")(fixture, target.unrelated),
      expectPrimaryReuse: false,
      diversityDimensions: { repositoryState: target.label, invalidationReason: "stale_evidence" },
    });
  }

  // --- Invalidation: command / definition digest changed (treatment verifier command differs) ---
  for (const target of TARGETS) {
    cases.push({
      id: nextId(`invalidation-command-${target.label}`),
      category: "invalidation",
      invalidationReason: "command_changed",
      fixtureFileSet: target.fileSet,
      verifierId: `fg12d.case.${target.label}.cmd`,
      verifierRelPath: target.primary,
      treatmentCommandOverride: `node --stack-trace-limit=64 --check ${target.primary}`,
      expectPrimaryReuse: false,
      diversityDimensions: { repositoryState: target.label, invalidationReason: "command_changed" },
    });
  }

  // --- Invalidation: new obligation / policy changed / plan changed materially (mixed-plan partial reuse) ---
  for (const target of TARGETS) {
    cases.push({
      id: nextId(`invalidation-newobligation-${target.label}`),
      category: "invalidation",
      invalidationReason: "new_obligation_added",
      fixtureFileSet: target.fileSet,
      verifierId: `fg12d.case.${target.label}.primary`,
      verifierRelPath: target.primary,
      extraRequiredVerifier: { id: `fg12d.case.${target.label}.extra`, relPath: target.dependency },
      expectPrimaryReuse: true, // primary reuses; extra runs fresh — proven inside runTrialCase
      diversityDimensions: { repositoryState: target.label, invalidationReason: "new_obligation_added" },
    });
  }

  // --- Invalidation: prior failed evidence (real production-path gap FG-11 flagged) ---
  for (let i = 0; i < 2; i++) {
    cases.push({
      id: nextId(`invalidation-failed-evidence-${i}`),
      category: "invalidation",
      invalidationReason: "prior_failed_evidence",
      fixtureFileSet: BILLING,
      verifierId: `fg12d.case.failed.${i}`,
      verifierRelPath: "src/billing/does-not-parse.js",
      expectBaselineFailure: true,
      expectPrimaryReuse: false,
      diversityDimensions: { repositoryState: "billing-broken", invalidationReason: "prior_failed_evidence" },
    });
  }

  return cases;
}
