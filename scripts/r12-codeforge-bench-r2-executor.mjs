#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateProtectedAcceptance } from "@codeforge/benchmark";

// The R11 adapter still owns fixture construction and the live workflow. R12 wraps its result
// so historical execution code and evidence remain untouched while the new protected stage is
// recorded in a separate namespace.
process.env.CODEFORGE_R2_EVIDENCE_DIR = process.env.CODEFORGE_R12_RAW_EVIDENCE_DIR
  ?? "docs/evidence/r12-release-closure/codeforge-bench-r2/raw";
const r11Executor = await import(pathToFileURL(path.resolve("scripts/r11-codeforge-bench-r2-executor.mjs")).href);

function protectedChecks(result) {
  const changedFiles = result.fixtureEvidence?.changedFiles ?? [];
  return [
    {
      id: "visible-acceptance",
      source: "workspace",
      observed: result.verification?.visibleAcceptance === "passed",
      detail: "The fixture test command completed with a passing exit status.",
    },
    {
      id: "hidden-acceptance",
      source: "authority",
      observed: result.hiddenAcceptance === "passed",
      detail: "The independent hidden verifier returned a passing result.",
    },
    {
      id: "completion-authority",
      source: "authority",
      observed: result.verification?.forgeVerify === "passed",
      detail: "The persisted ForgeVerify/completion authority inspection passed.",
    },
    {
      id: "terminal-state",
      source: "trace",
      observed: result.status === "completed",
      detail: `The workflow terminal status was ${result.status}.`,
    },
    {
      id: "final-diff-audit",
      source: "workspace",
      observed: changedFiles.every((file) => !/generated[\\/]|\\.generated\\./i.test(file)),
      detail: "The final changed-file set contains no generated-owner mutation.",
    },
  ];
}

export async function executeCase(context) {
  const result = await r11Executor.executeCase(context);
  const verification = result.verification ?? {
    verifierId: "r11-r2-independent-fixture-verifier",
    visibleAcceptance: "not_run",
    protectedAcceptance: "not_run",
    forgeVerify: "not_run",
  };
  if (context.case.split !== "PROTECTED_TEST") {
    return {
      ...result,
      verification: { ...verification, protectedAcceptance: "not_applicable" },
    };
  }

  const evaluation = evaluateProtectedAcceptance({
    split: "PROTECTED_TEST",
    requiredEvidence: context.case.requiredEvidence,
    visibleAcceptance: verification.visibleAcceptance,
    hiddenAcceptance: result.hiddenAcceptance ?? "not_run",
    forgeVerify: verification.forgeVerify ?? "not_run",
    finalState: result.fixtureEvidence?.diffHash
      ? {
          terminalStatus: result.status,
          diffHash: result.fixtureEvidence.diffHash,
          changedFiles: result.fixtureEvidence.changedFiles,
        }
      : undefined,
    checks: protectedChecks(result),
  });
  return {
    ...result,
    verification: {
      ...verification,
      protectedAcceptance: evaluation.state,
      protectedAcceptanceEvidence: evaluation.evidence,
    },
  };
}

export async function dispose() {
  if (typeof r11Executor.dispose === "function") await r11Executor.dispose();
}

export default { executeCase, dispose };
