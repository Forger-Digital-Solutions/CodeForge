import { describe, expect, it } from "vitest";
import { reverifyKiloPolicy } from "../src/kilo-policy-reverification.js";

describe("Kilo policy re-verification", () => {
  it("quarantines changed authoritative terms before refreshing a receipt", async () => {
    const fetcher = async (url: string | URL | Request): Promise<Response> => {
      const response = new Response("<main>changed terms</main>", { status: 200 });
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    expect(await reverifyKiloPolicy("2026-10-01T00:00:00Z", { fetcher: fetcher as typeof fetch })).toMatchObject({
      status: "CHANGED", source: "terms",
    });
  });

  it("does not renew evidence when the authoritative source disappears", async () => {
    const fetcher = async (): Promise<Response> => { throw new Error("offline"); };
    expect(await reverifyKiloPolicy("2026-10-01T00:00:00Z", { fetcher: fetcher as typeof fetch })).toMatchObject({
      status: "UNAVAILABLE", source: "terms",
    });
  });
});
