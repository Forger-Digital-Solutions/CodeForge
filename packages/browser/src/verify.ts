import { BrowserRuntimeError, GovernedBrowserRuntime } from "./runtime.js";

/**
 * ForgeVerify browser verification (R22 M9).
 *
 * The verifier is intentionally a *fresh, independent* governed session: it never attaches to
 * the agent's browser state, so a forged screenshot or a scripted page mutation inside the
 * agent's session cannot seed the verification result. The emitted verdict carries the final
 * URL, title, the DOM snapshot hash, and an optional screenshot digest — upstream, ForgeVerify
 * binds that output via outputDigest inside an evidence record already bound to inputStateHash.
 */

export interface BrowserVerificationSpec {
  url: string;
  expectSelector?: string;
  expectText?: string;
  /** RegExp source — matched against document.title. */
  expectTitlePattern?: string;
  /** Wait for this selector to be visible before evaluating expectations. */
  waitForSelector?: string;
  screenshot?: boolean;
  timeoutMs?: number;
}

export interface BrowserVerificationCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface BrowserVerificationResult {
  pass: boolean;
  url: string;
  finalUrl: string;
  title: string;
  domHash: string;
  screenshotHash?: string;
  checks: BrowserVerificationCheck[];
  durationMs: number;
}

export async function runBrowserVerification(
  runtime: GovernedBrowserRuntime,
  spec: BrowserVerificationSpec,
): Promise<BrowserVerificationResult> {
  const started = Date.now();
  const timeoutMs = Math.min(spec.timeoutMs ?? 30_000, 60_000);
  const session = await runtime.openSession();
  try {
    const checks: BrowserVerificationCheck[] = [];
    const nav = await session.navigate(spec.url, { waitUntil: "load" });
    checks.push({ name: "navigation", pass: true, detail: `loaded ${nav.url}` });

    if (spec.waitForSelector) {
      try {
        await session.waitFor({ selector: spec.waitForSelector, state: "visible", timeoutMs });
        checks.push({ name: "waitForSelector", pass: true, detail: `selector visible: ${spec.waitForSelector}` });
      } catch (error) {
        checks.push({
          name: "waitForSelector",
          pass: false,
          detail: `selector never became visible: ${spec.waitForSelector} (${error instanceof BrowserRuntimeError ? error.code : "error"})`,
        });
      }
    }

    const { snapshot } = await session.inspect();

    if (spec.expectSelector) {
      const hinted = snapshot.interactiveElements.some((el) => el.selectorHint === spec.expectSelector);
      let pass = hinted;
      if (!pass) {
        try {
          await session.waitFor({ selector: spec.expectSelector, state: "attached", timeoutMs: 1_000 });
          pass = true;
        } catch {
          pass = false;
        }
      }
      checks.push({ name: "expectSelector", pass, detail: pass ? `found ${spec.expectSelector}` : `missing ${spec.expectSelector}` });
    }
    if (spec.expectText !== undefined) {
      const found = snapshot.textExcerpt.includes(spec.expectText);
      checks.push({
        name: "expectText",
        pass: found,
        detail: found
          ? "text present in page excerpt"
          : `missing text: ${spec.expectText.slice(0, 120)}${snapshot.truncated ? " (excerpt truncated — text may exist below bound)" : ""}`,
      });
    }
    if (spec.expectTitlePattern) {
      let pass = false;
      try {
        pass = new RegExp(spec.expectTitlePattern).test(snapshot.title);
      } catch {
        pass = false;
      }
      checks.push({
        name: "expectTitle",
        pass,
        detail: pass ? `title matches /${spec.expectTitlePattern}/` : `title "${snapshot.title}" does not match /${spec.expectTitlePattern}/`,
      });
    }
    let screenshotHash: string | undefined;
    if (spec.screenshot) {
      const { record } = await session.screenshot({ persist: true });
      screenshotHash = record.sha256;
    }

    return {
      pass: checks.every((c) => c.pass),
      url: spec.url,
      finalUrl: nav.url,
      title: snapshot.title,
      domHash: snapshot.snapshotHash,
      ...(screenshotHash ? { screenshotHash } : {}),
      checks,
      durationMs: Date.now() - started,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}

export function verificationResultToText(result: BrowserVerificationResult): string {
  const lines = [
    `browser verification ${result.pass ? "PASSED" : "FAILED"}: ${result.url}`,
    `finalUrl=${result.finalUrl} title="${result.title}" domHash=${result.domHash}${result.screenshotHash ? ` screenshotHash=${result.screenshotHash}` : ""}`,
    ...result.checks.map((c) => `  ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`),
  ];
  return lines.join("\n");
}
