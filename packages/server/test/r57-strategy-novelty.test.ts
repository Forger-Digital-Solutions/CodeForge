import { describe, expect, it } from "vitest";
import { classifyRetryNovelty, strategyFingerprint, type StrategyObservation } from "../src/strategy-novelty.js";

const attempt = (stateDigest: string, extras: Partial<StrategyObservation> = {}): StrategyObservation => ({
  targetFiles: ["src/foo.ts"], failureCodes: ["TEST_X_FAILED"], stateDigest, ...extras,
});

describe("R57 strategy novelty", () => {
  it("intervenes after repeated same-strategy failure despite changed patch bytes", () => {
    const first = attempt("patch-a");
    const second = attempt("patch-b");
    const third = attempt("patch-c");
    expect(classifyRetryNovelty([], first)).toBe("NOVEL_STRATEGY");
    expect(classifyRetryNovelty([first], second)).toBe("LOW_NOVELTY_RETRY");
    expect(classifyRetryNovelty([first, second], third)).toBe("STRATEGY_EXHAUSTED");
    expect(classifyRetryNovelty([first, second], attempt("new", { targetFiles: ["src/dependency.ts"] }))).toBe("NOVEL_STRATEGY");
  });

  it("permits bounded transient retry and recognizes materially changed failure evidence", () => {
    const first = attempt("a");
    expect(classifyRetryNovelty([first], attempt("a", { transient: true }))).toBe("SAME_STRATEGY_ALLOWED_TRANSIENT");
    expect(classifyRetryNovelty([first], attempt("b", { failureCodes: ["TEST_Y_FAILED"] }))).toBe("MATERIAL_NEW_EVIDENCE");
  });

  it("stores fingerprints rather than filenames", () => {
    const fingerprint = strategyFingerprint(attempt("digest", { targetFiles: ["C:/private/acme/source.ts"] }));
    expect(JSON.stringify(fingerprint)).not.toContain("acme");
  });
});
