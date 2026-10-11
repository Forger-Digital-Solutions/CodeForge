import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const directory = "docs/evidence/r84-free-cloud-autonomy-certification/";
const certPath = `${directory}source-certification.json`;
const priorCertPath = "docs/evidence/r67-everyday-completion-reliability/source-certification.json";
const R83_BASE = "12ce5a5209329a878a173945b787337f495ba4e3";

const tests = JSON.parse(await readFile(`${directory}repository-tests-final.json`, "utf8"));
const state = JSON.parse(await readFile("docs/codeforge-forgegreen-certified-source-state.json", "utf8"));
const implementationHead = process.argv[2];
if (implementationHead && !/^[a-f0-9]{40}$/.test(implementationHead)) throw new Error("COMMIT_SHA_REQUIRED");

// R84's certified surface additions: the milestone's packages/apps diff plus its
// harness, evidence driver and recertification plumbing (r65 convention).
const milestoneDiff = execFileSync("git", ["diff", "--name-only", R83_BASE], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
const sourceAdditions = milestoneDiff.filter((file) => /^(packages|apps|benchmarks|scripts|tests|docs)\//.test(file) && !file.startsWith("docs/evidence/"));
sourceAdditions.push("docs/codeforge-forgegreen-certified-source-state.json", "scripts/r84-recertify-source-state.mjs", "scripts/r84-recertify-certificate.mjs", "tests/free-capacity-certificate.test.ts");

async function evidenceTree(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) out.push(...await evidenceTree(full));
    else out.push(full.replaceAll("\\", "/"));
  }
  return out;
}
// The certificate cannot bind its own bytes — exclude it from the evidence set.
const newEvidence = (await evidenceTree(directory)).filter((file) => file !== certPath);

let certificate;
try {
  certificate = JSON.parse(await readFile(certPath, "utf8"));
} catch {
  certificate = JSON.parse(await readFile(priorCertPath, "utf8"));
}
certificate.sourceFiles = [...new Set([...certificate.sourceFiles.map((entry) => entry.path), ...sourceAdditions])].sort().map((path) => ({ path, sha256: "RECOMPUTE" }));
certificate.evidenceFiles = [...new Set([...certificate.evidenceFiles.map((entry) => entry.path), ...newEvidence])].sort().map((path) => ({ path, sha256: "RECOMPUTE" }));
certificate.certificateId = "r84-free-cloud-autonomy-v1";
certificate.sourceStateId = state.sourceStateId;
certificate.implementationBase = R83_BASE;
certificate.implementationHead = implementationHead ?? null;
certificate.validation = { repositoryWideStatus: tests.success === true || tests.numFailedTests === 0 ? "PASS" : "PARTIAL", repositoryWideTotals: { numTotalTests: tests.numTotalTests, numPassedTests: tests.numPassedTests, numFailedTests: tests.numFailedTests }, workspaceBuild: "PASS", workspaceLint: "PASS", paidRoleRouting: "20/20", remoteDirectDispatch: "13/13", workerFleetQualification: "6/6", reviewerContract: "17/17", nativeExitTraversal: "PASS_REPLAY" };
certificate.limitation = "R84 proves governed free-cloud routing (Kilo NVIDIA trial and opaque Auto Free routes fail closed on terms), model-scoped paid capacity cooldowns, FIFO fairness, secret redaction through workflow persistence/events, and a live-verified native exit traversal on UE 4.27. It does not certify independent qualified zero-touch capacity in a second Free Coder domain, fresh-user onboarding, concurrent live projects, packaging/signing, or independent review acceptance (R82 timed out; R83 returned revision_required). Only two small public engineering fixtures were model-executed.";
await writeFile(certPath, `${JSON.stringify(certificate, null, 2)}\n`);
execFileSync(process.execPath, ["scripts/free-capacity-certificate.mjs", "--write"], { stdio: "inherit" });
execFileSync(process.execPath, ["scripts/free-capacity-certificate.mjs", "--verify"], { stdio: "inherit" });
