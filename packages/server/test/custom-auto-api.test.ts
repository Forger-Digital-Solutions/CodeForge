import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";

async function request(
  port: number,
  route: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: response.status, body: json };
}

describe("Custom AUTO and Forge Auto HTTP API", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    port = (server as unknown as { httpPort: number }).httpPort;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("lists empty Custom AUTO profiles initially", async () => {
    const res = await request(port, "/api/custom-autos");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("creates, retrieves, updates, and deletes a Custom AUTO profile", async () => {
    // 1. Create
    const createPayload = {
      id: "my-custom-pipeline",
      name: "My Custom Pipeline",
      description: "Fast local dev pipeline",
      roles: {
        coder: { providerId: "openrouter", modelId: "deepseek/deepseek-chat" },
        reviewer: { providerId: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct" },
      },
    };
    const createRes = await request(port, "/api/custom-autos", "POST", createPayload);
    expect(createRes.status).toBe(201);
    expect(createRes.body.id).toBe("my-custom-pipeline");
    expect(createRes.body.name).toBe("My Custom Pipeline");
    expect(createRes.body.trustDomain).toBe("USER_CUSTOM_AUTO");

    // 2. List
    const listRes = await request(port, "/api/custom-autos");
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBe(1);
    expect(listRes.body[0].id).toBe("my-custom-pipeline");

    // 3. Get single
    const getRes = await request(port, "/api/custom-autos/my-custom-pipeline");
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe("my-custom-pipeline");
    expect(getRes.body.roles.coder.providerId).toBe("openrouter");

    // 4. Update
    const updateRes = await request(port, "/api/custom-autos/my-custom-pipeline", "PATCH", {
      description: "Updated description",
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.description).toBe("Updated description");

    // 5. Select profile
    const selectRes = await request(port, "/api/model-selection", "POST", {
      customAutoProfileId: "my-custom-pipeline",
    });
    expect(selectRes.status).toBe(200);
    expect(selectRes.body.ok).toBe(true);
    expect(selectRes.body.selection.customAutoProfileId).toBe("my-custom-pipeline");
    expect(selectRes.body.selection.trustDomain).toBe("USER_CUSTOM_AUTO");

    // 6. Delete
    const deleteRes = await request(port, "/api/custom-autos/my-custom-pipeline", "DELETE");
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);

    // 7. Verify deletion
    const getAfterDelete = await request(port, "/api/custom-autos/my-custom-pipeline");
    expect(getAfterDelete.status).toBe(404);
  });

  it("rejects Custom AUTO profile using CodeForge-managed free providers", async () => {
    const invalidPayload = {
      id: "violating-profile",
      name: "Violating Profile",
      roles: {
        coder: { providerId: "codeforge", modelId: "llama-3" },
      },
    };
    const res = await request(port, "/api/custom-autos", "POST", invalidPayload);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("CodeForge-managed free provider");
  });

  it("handles /api/forge-auto/team preview and /api/forge-auto/delegations", async () => {
    const teamRes = await request(port, "/api/forge-auto/team?task=Fix+login+bug");
    expect(teamRes.status).toBe(200);
    expect(teamRes.body).toBeDefined();

    const delegRes = await request(port, "/api/forge-auto/delegations");
    expect(delegRes.status).toBe(200);
    expect(Array.isArray(delegRes.body)).toBe(true);
  });
});
