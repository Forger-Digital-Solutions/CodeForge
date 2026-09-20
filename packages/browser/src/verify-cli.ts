import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BROWSER_POLICY } from "./policy.js";
import { GovernedBrowserRuntime } from "./runtime.js";
import { runBrowserVerification, verificationResultToText, type BrowserVerificationSpec } from "./verify.js";

/**
 * ForgeVerify browser verifier entrypoint (R22 M9). Executed as a subprocess by the
 * verification engine: the verdict on stdout becomes the evidence output digest, and the
 * exit code becomes the attempt status. Exit 0 = pass, 1 = failed checks, 2 = infra/policy.
 *
 *   node verify-cli.js --url <u> [--expect-selector <css>] [--expect-text <t>]
 *                      [--expect-title <regex>] [--wait-for <css>] [--screenshot]
 *                      [--allow-private-network] [--timeout-ms <n>]
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const flag = (name: string): boolean => args.includes(name);

  const url = opt("--url");
  if (!url) {
    process.stderr.write("verify-cli: --url is required\n");
    return 2;
  }
  const spec: BrowserVerificationSpec = {
    url,
    ...(opt("--expect-selector") ? { expectSelector: opt("--expect-selector") } : {}),
    ...(opt("--expect-text") !== undefined ? { expectText: opt("--expect-text") } : {}),
    ...(opt("--expect-title") ? { expectTitlePattern: opt("--expect-title") } : {}),
    ...(opt("--wait-for") ? { waitForSelector: opt("--wait-for") } : {}),
    ...(flag("--screenshot") ? { screenshot: true } : {}),
    ...(opt("--timeout-ms") ? { timeoutMs: Number(opt("--timeout-ms")) } : {}),
  };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "forgeverify-browser-"));
  const runtime = new GovernedBrowserRuntime({
    policy: {
      ...DEFAULT_BROWSER_POLICY,
      ...(flag("--allow-private-network") ? { allowPrivateNetwork: true } : {}),
    },
    downloadDir: scratch,
    screenshotDir: spec.screenshot ? path.join(scratch, "shots") : undefined,
    headless: true,
    maxSessions: 1,
  });

  try {
    const result = await runBrowserVerification(runtime, spec);
    process.stdout.write(`${verificationResultToText(result)}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.pass ? 0 : 1;
  } catch (error) {
    process.stdout.write(`browser verification ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`verify-cli fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
