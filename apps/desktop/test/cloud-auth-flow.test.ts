import { describe, expect, it } from "vitest";
import { CloudAuthError, describeCloudAuthFailure, runCodeForgeCloudAuth } from "../src/cloud-auth-flow.js";

describe("CodeForge Cloud desktop OAuth compatibility", () => {
  it("checks the Cloud contract before beginning OAuth against a stale deployment", async () => {
    const requests: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      requests.push(url.toString());
      return new Response(JSON.stringify({
        apiVersion: "1.0.0",
        serverVersion: "0.2.0",
        features: ["HOSTED_FREE", "DYNAMIC_MODELS"],
      }));
    }) as typeof fetch;

    await expect(runCodeForgeCloudAuth({
      cloudApiUrl: "https://cloud.example",
      fetchFn,
      openExternal: async () => { throw new Error("OAuth browser must not open for an incompatible Cloud"); },
    })).rejects.toMatchObject({ kind: "configuration", message: expect.stringMatching(/needs an update/i) });

    expect(requests).toEqual(["https://cloud.example/v1/meta"]);
  });

  it("surfaces a compatibility configuration failure without hiding the operator-actionable reason", () => {
    const error = new CloudAuthError("configuration", "CodeForge Cloud needs an update before this desktop release can connect.");
    expect(describeCloudAuthFailure(error)).toBe(error.message);
  });
});
