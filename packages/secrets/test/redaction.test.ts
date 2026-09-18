import { describe, expect, it } from "vitest";
import { containsSecret, redactSecrets, SecretScanner } from "../src/index.js";

describe("credential retention boundaries", () => {
  it("redacts provider keys, bearer tokens, and OAuth values in plain output", () => {
    const text = [
      "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      "access_token=gho_abcdefghijklmnopqrstuvwxyz123456",
      "refresh_token: refresh-value-123456789",
    ].join("\n");
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain("sk-or-v1-abcdef");
    expect(redacted).not.toContain("Bearer eyJ");
    expect(redacted).not.toContain("gho_abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("refresh-value-123456789");
    expect(redacted).toContain("[REDACTED]");
  });

  it("recognizes credential-like values without treating marked synthetic labels as secrets", () => {
    const scanner = new SecretScanner();
    expect(containsSecret("patch: +const key = 'sk-proj-1234567890abcdef'")).toBe(true);
    expect(scanner.scan("SYNTHETIC_API_KEY_PLACEHOLDER".repeat(2))).toHaveLength(0);
    expect(redactSecrets("SYNTHETIC_API_KEY_PLACEHOLDER")).toBe("SYNTHETIC_API_KEY_PLACEHOLDER");
  });

  it("redacts credentials in generated patches and tool output while preserving surrounding evidence", () => {
    const output = redactSecrets("tool output: file=config.json\n+ api_key: sk-abcdef0123456789\nstatus: verified");
    expect(output).toContain("tool output");
    expect(output).toContain("status: verified");
    expect(output).not.toContain("sk-abcdef0123456789");
  });
});
