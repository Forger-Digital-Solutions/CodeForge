import { describe, expect, it } from "vitest";
import { GitHubPRClient } from "../src/github-pr-client.js";
import { PUBLICATION_ERROR_CODES } from "../src/publication-errors.js";

const REQUEST = {
  owner: "codeforge",
  repo: "fixture",
  head: "codeforge/delivery-1",
  base: "main",
  title: "Delivery",
  body: "Certified delivery",
  expectedHeadSha: "a".repeat(40),
  token: "synthetic-token",
};

function pull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    html_url: "https://github.test/codeforge/fixture/pull/42",
    state: "open",
    head: { ref: REQUEST.head, sha: REQUEST.expectedHeadSha },
    base: { ref: REQUEST.base },
    ...overrides,
  };
}

describe("GitHubPRClient certified-head reconciliation", () => {
  it("fails closed when GitHub creates a PR but omits its head SHA", async () => {
    const methods: string[] = [];
    const client = new GitHubPRClient({
      apiBase: "https://github.test",
      fetchFn: (async (_url, init) => {
        methods.push(init?.method ?? "GET");
        return new Response(JSON.stringify(init?.method === "POST" ? pull({ head: { ref: REQUEST.head } }) : []), { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.createOrReconcile(REQUEST)).rejects.toMatchObject({ code: PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED });
    expect(methods).toEqual(["GET", "POST"]);
  });

  it("does not accept a closed PR as a completed publication reconciliation", async () => {
    const methods: string[] = [];
    const client = new GitHubPRClient({
      apiBase: "https://github.test",
      fetchFn: (async (_url, init) => {
        methods.push(init?.method ?? "GET");
        return new Response(JSON.stringify([pull({ state: "closed" })]), { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.createOrReconcile(REQUEST)).rejects.toMatchObject({ code: PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED });
    expect(methods).toEqual(["GET"]);
  });
});
