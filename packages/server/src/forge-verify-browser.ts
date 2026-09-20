import { verifyCliPath, type BrowserVerificationSpec } from "@codeforge/browser";
import type { VerifierDefinition, VerifierId, VerifierVersion } from "@codeforge/workflow";

/**
 * ForgeVerify browser verifier factory (R22 M9).
 *
 * Produces a standard VerifierDefinition whose StructuredCommand executes the governed-browser
 * verification CLI as an independent subprocess. Because it is an ordinary verifier, all of
 * ForgeVerify's binding rules apply unchanged: the plan is bound to inputStateHash, the
 * definition content (including the exact URL and expectations) is bound via definitionDigest,
 * the verdict output is bound via outputDigest, and evidence is integrity-hashed and
 * rebind-checked at the completion gate. A verifier defined before an edit goes stale — the
 * gate re-evaluates inputStateHash at decision time.
 *
 * supportedScopes: "integration" and "publication" — browser evidence is external-world proof,
 * never a substitute for workspace verifiers (typecheck/tests) on the "workspace" scope.
 */
export function browserVerificationDefinition(spec: BrowserVerificationSpec & {
  id?: string;
  requirement?: VerifierDefinition["defaultRequirement"];
  allowPrivateNetwork?: boolean;
}): VerifierDefinition {
  const args: string[] = [verifyCliPath(), "--url", spec.url];
  if (spec.expectSelector) args.push("--expect-selector", spec.expectSelector);
  if (spec.expectText !== undefined) args.push("--expect-text", spec.expectText);
  if (spec.expectTitlePattern) args.push("--expect-title", spec.expectTitlePattern);
  if (spec.waitForSelector) args.push("--wait-for", spec.waitForSelector);
  if (spec.screenshot) args.push("--screenshot");
  if (spec.allowPrivateNetwork) args.push("--allow-private-network");
  const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 30_000, 5_000), 60_000);
  args.push("--timeout-ms", String(timeoutMs));

  // The verifier id embeds the spec so two browser verifications of different pages can never
  // alias one another's evidence.
  const idSuffix = Buffer.from(JSON.stringify({
    url: spec.url,
    s: spec.expectSelector,
    t: spec.expectText,
    ti: spec.expectTitlePattern,
    w: spec.waitForSelector,
  })).toString("base64url").slice(0, 32);

  return {
    id: (spec.id ?? `forgeverify.browser.${idSuffix}`) as VerifierId,
    version: "r22.1" as VerifierVersion,
    name: `Browser verification: ${spec.url}`,
    category: "e2e-test",
    description: `Independent governed-browser check of ${spec.url}`,
    execution: { executable: process.execPath, args },
    defaultRequirement: spec.requirement ?? "required",
    // The verifier subprocess launches a fresh browser — head room beyond the spec timeout.
    timeoutMs: timeoutMs + 45_000,
    maxAttempts: 2,
    supportedScopes: ["integration", "publication"],
  };
}
