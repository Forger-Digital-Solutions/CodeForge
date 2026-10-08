import { describe, expect, it } from "vitest";
import { runPuterAccountFlow } from "../src/puter-account-flow.js";

describe("Puter browser account observation", () => {
  it("uses a one-use loopback callback and rejects wrong origins and nonces", async () => {
    let callback = "";
    const authorization = await runPuterAccountFlow({ timeoutMs: 5_000, openExternal: async (address) => {
      const url = new URL(address);
      expect(url.hostname).toBe("127.0.0.1");
      const page = await fetch(url);
      expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      const html = await page.text();
      expect(html).toContain("https://js.puter.com/v2/");
      expect(html).not.toContain("puter.ai.chat");
      const nonce = url.pathname.split("/").at(-1)!;
      callback = `${url.origin}/callback`;
      const body = JSON.stringify({ token: "fixture-secret", accountId: "account-one", catalogModels: 13, remainingMicrocents: 0 });
      for (const headers of [
        { Origin: "https://attacker.invalid", "X-CodeForge-Nonce": nonce },
        { Origin: url.origin, "X-CodeForge-Nonce": "wrong" },
      ]) expect((await fetch(callback, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body })).status).toBe(403);
      expect((await fetch(callback, { method: "POST", headers: { Origin: url.origin, "X-CodeForge-Nonce": nonce, "Content-Type": "application/json" }, body })).status).toBe(200);
    } });
    expect(authorization).toEqual({ token: "fixture-secret", accountId: "account-one", catalogModels: 13, remainingMicrocents: 0 });
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("closes failed browser launches and allows a subsequent authorization", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(runPuterAccountFlow({ openExternal: async () => { throw new Error("secret-browser-error"); } })).rejects.toThrow("Could not open Puter authorization");
    }
  });
});
