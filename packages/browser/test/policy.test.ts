import { describe, it, expect } from "vitest";
import {
  assertUrlAllowed,
  checkUrl,
  classifyIp,
  DEFAULT_BROWSER_POLICY,
} from "../src/index.js";

describe("browser URL policy", () => {
  it("allows https public targets and loopback http", () => {
    expect(checkUrl("https://example.com/page").allowed).toBe(true);
    expect(checkUrl("http://localhost:3000/app").allowed).toBe(true);
    expect(checkUrl("http://127.0.0.1:8080").allowed).toBe(true);
    expect(checkUrl("http://[::1]:9000").allowed).toBe(true);
  });

  it("denies dangerous schemes and credential-bearing URLs", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "ftp://example.com/x",
      "codeforge://internal",
      "https://user:pass@example.com/",
      "not a url",
      "",
    ]) {
      expect(checkUrl(url).allowed, url).toBe(false);
    }
  });

  it("denies plaintext http off-loopback by default", () => {
    expect(checkUrl("http://example.com").allowed).toBe(false);
    expect(checkUrl("http://192.168.1.5").allowed).toBe(false);
  });

  it("always denies cloud metadata and link-local endpoints", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "https://169.254.169.254/",
      "http://metadata.google.internal/",
      "http://100.100.2.136/",
      "http://[fe80::1]/",
      "http://[fd00:ec2::254]/",
    ]) {
      expect(checkUrl(url).allowed, url).toBe(false);
    }
  });

  it("denies RFC-1918/private targets unless the policy opts in", () => {
    expect(checkUrl("http://10.0.0.4/").allowed).toBe(false);
    expect(checkUrl("http://192.168.0.9/").allowed).toBe(false);
    expect(checkUrl("http://172.16.5.5/").allowed).toBe(false);
    const permissive = { ...DEFAULT_BROWSER_POLICY, allowPrivateNetwork: true };
    expect(checkUrl("http://192.168.0.9/", permissive).allowed).toBe(true);
    // Metadata stays denied even when private is allowed.
    expect(checkUrl("http://169.254.169.254/", permissive).allowed).toBe(false);
  });

  it("denies unspecified and multicast literals", () => {
    expect(checkUrl("http://0.0.0.0/").allowed).toBe(false);
    expect(checkUrl("http://224.0.0.1/").allowed).toBe(false);
  });

  it("classifies IPv4-mapped IPv6 addresses correctly", () => {
    expect(classifyIp("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyIp("::ffff:169.254.169.254")).toBe("metadata");
    expect(classifyIp("::ffff:7f00:1")).toBe("loopback");
  });

  it("rejects hostnames that resolve to metadata or private addresses (rebinding)", async () => {
    const fakeResolver = async (host: string): Promise<string[]> =>
      host === "evil.example.com" ? ["169.254.169.254"] : host === "lan.example.com" ? ["10.1.2.3"] : ["93.184.216.34"];
    const deniedMeta = await assertUrlAllowed("https://evil.example.com/", DEFAULT_BROWSER_POLICY, fakeResolver);
    expect(deniedMeta.allowed).toBe(false);
    const deniedPrivate = await assertUrlAllowed("https://lan.example.com/", DEFAULT_BROWSER_POLICY, fakeResolver);
    expect(deniedPrivate.allowed).toBe(false);
    const ok = await assertUrlAllowed("https://good.example.com/", DEFAULT_BROWSER_POLICY, fakeResolver);
    expect(ok.allowed).toBe(true);
  });

  it("fails closed when DNS cannot resolve", async () => {
    const result = await assertUrlAllowed("https://nope.invalid/", DEFAULT_BROWSER_POLICY, async () => {
      throw new Error("ENOTFOUND");
    });
    expect(result.allowed).toBe(false);
  });

  it("allowedHosts bypasses DNS classification for named entries only", async () => {
    const policy = { ...DEFAULT_BROWSER_POLICY, allowedHosts: new Set(["internal.corp"]) };
    const result = await assertUrlAllowed("https://internal.corp/x", policy, async () => {
      throw new Error("should not resolve");
    });
    expect(result.allowed).toBe(true);
    const other = await assertUrlAllowed("https://other.corp/", policy, async () => ["93.184.216.34"]);
    expect(other.allowed).toBe(true);
  });
});
