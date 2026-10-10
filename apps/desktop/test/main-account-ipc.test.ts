import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { ProviderError, type ProviderAdapter, type StreamEvent } from "@codeforge/providers";
import type { ConnectedAccountView } from "../src/connected-account-types.js";
import type { PaidQualificationOptions } from "../src/provider-account-qualification.js";
import { personalPaidQualificationAdmission } from "../src/provider-account-routing.js";

type Handler = (...args: unknown[]) => unknown;

function productionHandler(channel: string, host: Record<string, unknown>): Handler {
  const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let handler: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === "ipcMain"
      && node.expression.name.text === "handle" && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) handler = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!handler) throw new Error(`Missing production handler: ${channel}`);
  const compiled = ts.transpileModule(`(${handler.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return runInNewContext(compiled, host) as Handler;
}

function productionAccountSync(host: Record<string, unknown>): () => Promise<void> {
  const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = source.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === "synchronizeProviderAccounts"
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text.startsWith("accountRuntimeSync")));
  if (!declarations.some(node => ts.isFunctionDeclaration(node))) throw new Error("Missing account synchronization");
  const compiled = ts.transpileModule(`${declarations.map(node => node.getText(source)).join("\n")}\nsynchronizeProviderAccounts;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return runInNewContext(compiled, host) as () => Promise<void>;
}

function productionFunction(name: string, host: Record<string, unknown>): (...args: unknown[]) => unknown {
  const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing production function: ${name}`);
  const compiled = ts.transpileModule(`${declaration.getText(source)}\n${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return runInNewContext(compiled, host) as (...args: unknown[]) => unknown;
}

function fixtureAccount(): ConnectedAccountView {
  return { connectionId: "7e9b4ba9-10cb-46ee-a6ba-e6d075c7a1a6", providerId: "openrouter", providerName: "OpenRouter", maskedIdentity: "Account ••••12345678",
    authMethod: "OAUTH_PKCE", connected: true, enabled: true, authState: "ok", classification: "PAID", freeOnly: true, paidSpendingEnabled: false,
    preference: "AUTO", freeRouteCount: 0, qualifiedModels: [], paidDispatchEligible: false };
}

function handlerHost() {
  const account = fixtureAccount();
  let owner = "owner-a";
  const privateAuthority = { ownerUserId: owner, credentialRef: "private-credential-reference", credentialFingerprint: "private-fingerprint" };
  const connections = { accountOwnerUserId: () => owner, listProviderAccounts: () => [account], providerAccountAuthority: () => privateAuthority,
    updateProviderAccount: vi.fn(() => account), disconnectProviderAccount: vi.fn(async () => {}),
    addProviderAccount: vi.fn(async () => ({ ok: true, connection: account })),
    replaceProviderAccountCredential: vi.fn(async () => ({ ok: true, connection: account })),
    connectOAuthAccount: vi.fn(async (_key: string, options: { expectedOwnerUserId: string }) => options.expectedOwnerUserId === owner ? { ok: true, connection: account } : { ok: false, error: "Owner changed" }) };
  const host = { assertMainWindowSender: vi.fn(), requireConnections: () => connections, isKnownProviderId: () => true, PACKAGED_SMOKE: false,
    userConnectedFreeScopeId: () => owner, synchronizeProviderAccounts: vi.fn(async () => {}), notifyProviderChanged: vi.fn(),
    runOpenRouterOAuth: vi.fn(async () => "fixture-exchanged-key"), server: undefined };
  return { account, connections, host, owner: (value: string) => { owner = value; } };
}

const channels = ["providerAccounts:list", "providerAccounts:add", "providerAccounts:update", "providerAccounts:disconnect", "providerAccounts:replaceCredential", "providerAccounts:oauth", "providerAccounts:qualify", "providerAccounts:estimatePresented", "providerRouting:getPolicy", "providerRouting:setPolicy"];

describe("production connected-account IPC authority", () => {
  it("synchronizes the latest owner when a login change races an earlier account synchronization", async () => {
    let owner = "owner-a";
    let runtimeOwner = "owner-a";
    let releaseFirst: (() => void) | undefined;
    const firstPaused = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const owners: string[] = [];
    const runtime = { setLocalUserId: async (value: string) => { runtimeOwner = value; owners.push(value); if (value === "owner-a") await firstPaused; },
      listUserIntelligenceSources: async () => [], putUserIntelligenceSource: async () => {} };
    const connections = { accountOwnerUserId: () => owner, listProviderAccounts: () => [] };
    const synchronize = productionAccountSync({ server: runtime, providerConnections: connections, userConnectedFreeScopeId: () => owner, currentWorkspacePath: undefined });
    const first = synchronize();
    owner = "owner-b";
    const second = synchronize();
    releaseFirst!();
    await Promise.all([first, second]);
    expect(runtimeOwner).toBe("owner-b");
    expect(owners.at(-1)).toBe("owner-b");
  });

  it.each(channels)("rejects an untrusted sender before touching %s", async (channel) => {
    const touched = vi.fn();
    const handler = productionHandler(channel, { assertMainWindowSender: () => { throw new Error("IPC_SENDER_REJECTED"); }, requireConnections: touched });
    await expect(async () => handler({ sender: "foreign-window" }, "openrouter", { apiKey: "fixture-key" })).rejects.toThrow("IPC_SENDER_REJECTED");
    expect(touched).not.toHaveBeenCalled();
  });

  it("lists only owned view data and counts available routes by exact connection", async () => {
    const h = handlerHost();
    const candidates = [
      { personalConnectionId: h.account.connectionId, providerModelId: "verified-model", personalAdmission: "FREE_VERIFIED", available: true, credentialRef: "never-renderer" },
      { personalConnectionId: h.account.connectionId, providerModelId: "unavailable-model", personalAdmission: "FREE_VERIFIED", available: false },
      { personalConnectionId: "different-connection", providerModelId: "other-account-model", personalAdmission: "FREE_VERIFIED", available: true },
    ];
    const handler = productionHandler("providerAccounts:list", { ...h.host, server: { personalAccountCandidates: () => candidates } });
    const result = await handler({});
    expect(result).toMatchObject([{ connectionId: h.account.connectionId, qualifiedModels: ["verified-model"], freeRouteCount: 1, paidSpendingEnabled: false }]);
    expect(JSON.stringify(result)).not.toMatch(/credentialRef|credentialFingerprint|ownerUserId|never-renderer|fixture-exchanged-key/);
  });

  it("wraps an account update view and a disconnect receipt without private authority", async () => {
    const h = handlerHost();
    const update = productionHandler("providerAccounts:update", h.host);
    expect(await update({}, h.account.connectionId, { enabled: false })).toEqual({ ok: true, connection: h.account });
    const disconnect = productionHandler("providerAccounts:disconnect", h.host);
    expect(await disconnect({}, h.account.connectionId)).toEqual({ ok: true });
    expect(h.connections.disconnectProviderAccount).toHaveBeenCalledWith(h.account.connectionId);
  });

  it("binds OAuth to the owner who started the browser flow and rejects a changed owner", async () => {
    const h = handlerHost();
    h.host.runOpenRouterOAuth = vi.fn(async () => { h.owner("owner-b"); return "fixture-exchanged-key"; });
    const result = await productionHandler("providerAccounts:oauth", h.host)({}, "openrouter", {}, "default");
    expect(result).toMatchObject({ ok: false });
    if (h.connections.connectOAuthAccount.mock.calls.length) expect(h.connections.connectOAuthAccount.mock.calls[0]?.[1].expectedOwnerUserId).toBe("owner-a");
    expect(JSON.stringify(result)).not.toContain("fixture-exchanged-key");
  });

  it.each(["providerAccounts:add", "providerAccounts:update", "providerAccounts:replaceCredential", "providerAccounts:oauth"])("does not return a prior owner's connection after awaited synchronization in %s", async (channel) => {
    const h = handlerHost();
    h.host.synchronizeProviderAccounts = vi.fn(async () => { h.owner("owner-b"); });
    const handler = productionHandler(channel, h.host);
    const result = channel === "providerAccounts:add" ? await handler({}, "openrouter", { apiKey: "fixture-key" })
      : channel === "providerAccounts:oauth" ? await handler({}, "openrouter", {}, "default")
      : await handler({}, h.account.connectionId, channel === "providerAccounts:update" ? { enabled: false } : { apiKey: "fixture-key" });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(h.account.connectionId);
  });
});

describe("production account qualification", () => {
  function qualificationHost(frames: StreamEvent[], afterFrame?: (frame: StreamEvent) => void) {
    const h = handlerHost();
    const authority = { ownerUserId: "owner-a", providerId: "openrouter", credentialRef: "fixture-private-reference", credentialFingerprint: "fixture-fingerprint", freeAdmissionVerified: true,
      freeRequests: { limit: 50, remaining: 50 } };
    const model = { modelId: "vendor/model:free", displayName: "Free Model", isFree: true, freeStatus: "verified_free", capabilities: { toolCalling: true },
      pricing: { tokenOnly: true, inputCostPerMillion: 0, outputCostPerMillion: 0 } };
    const released: StreamEvent[] = [];
    const failures: unknown[] = [];
    const store = { get: () => "fixture-private-key" };
    const connections = { ...h.connections, recheckProviderAccount: vi.fn(async () => ({ ok: true })), providerAccountAuthority: () => ({ ...authority }),
      providerAccountCredentialStore: () => store, providerAccountModels: () => ({ models: [model] }), definition: () => ({ id: "openrouter" }) };
    const transport = { providerId: "openrouter", isTestProvider: true, listModels: vi.fn(async () => [model]), healthCheck: vi.fn(async () => ({ status: "available" })),
      chat: vi.fn(async () => ({ model: model.modelId, usage: { costUsd: 0 } })), async *streamChat() { for (const frame of frames) { afterFrame?.(frame); yield frame; } } };
    const freeCloud = { getReceipt: () => undefined, recordReceipt: vi.fn(async () => {}) };
    const host = { ...h.host, requireConnections: () => connections, freeCloud, qualifyingAccounts: new Set(), createProviderAdapterFromDefinition: () => transport,
      createGenericFreeRecord: (record: unknown) => record, AbortSignal, ProviderError,
      runRoleAwareQualification: vi.fn(async (_record: unknown, adapter: ProviderAdapter) => {
        try {
          for await (const frame of adapter.streamChat({ model: model.modelId, messages: [{ role: "user", content: "public qualification fixture" }] })) released.push(frame);
        } catch (error) { failures.push(error); throw error; }
        return { qualificationState: "QUALIFIED", roleResults: { REVIEWER: { status: "QUALIFIED" } } };
      }) };
    return { ...h, authority, model, connections, transport, freeCloud, host, released, failures };
  }

  it.each(["different/model", undefined])("withholds tool results for an unverified served model %s", async (servedModel) => {
    const h = qualificationHost([{ type: "tool_call_completed", toolCallId: "read-1", toolName: "read_file", arguments: "{}" },
      { type: "finish", finishReason: "tool_calls", ...(servedModel ? { model: servedModel } : {}) }]);
    expect(await productionHandler("providerAccounts:qualify", h.host)({}, h.account.connectionId)).toMatchObject({ ok: false });
    expect(h.released).toEqual([]);
    expect(h.failures).toMatchObject([{ code: servedModel ? "MODEL_SUBSTITUTED" : "MODEL_IDENTITY_MISSING", retryable: true }]);
    expect(h.freeCloud.recordReceipt).not.toHaveBeenCalled();
  });

  it("requires a terminal response before releasing qualification text or tools", async () => {
    const h = qualificationHost([{ type: "text_delta", delta: "apparently valid answer" }]);
    expect(await productionHandler("providerAccounts:qualify", h.host)({}, h.account.connectionId)).toMatchObject({ ok: false });
    expect(h.released).toEqual([]);
    expect(h.freeCloud.recordReceipt).not.toHaveBeenCalled();
  });

  it("rejects credential replacement during a qualification response", async () => {
    let h: ReturnType<typeof qualificationHost>;
    h = qualificationHost([{ type: "finish", finishReason: "stop", model: "vendor/model:free" }], () => { h.authority.credentialFingerprint = "replacement-fingerprint"; });
    expect(await productionHandler("providerAccounts:qualify", h.host)({}, h.account.connectionId)).toMatchObject({ ok: false });
    expect(h.released).toEqual([]);
    expect(h.freeCloud.recordReceipt).not.toHaveBeenCalled();
  });

  it("disables a route that reports a charge and does not release its result", async () => {
    const h = qualificationHost([{ type: "usage", usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.01 } },
      { type: "finish", finishReason: "stop", model: "vendor/model:free" }]);
    expect(await productionHandler("providerAccounts:qualify", h.host)({}, h.account.connectionId)).toMatchObject({ ok: false });
    expect(h.connections.updateProviderAccount).toHaveBeenCalledWith(h.account.connectionId, { enabled: false });
    expect(h.released).toEqual([]);
  });

  it("persists a qualified exact-model response after checking the same account authority", async () => {
    const frames: StreamEvent[] = [{ type: "text_delta", delta: "valid result" }, { type: "finish", finishReason: "stop", model: "vendor/model:free" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 1, costUsd: 0 } }];
    const h = qualificationHost(frames);
    expect(await productionHandler("providerAccounts:qualify", h.host)({}, h.account.connectionId)).toMatchObject({ ok: true });
    expect(h.released).toEqual(frames);
    expect(h.freeCloud.recordReceipt).toHaveBeenCalledOnce();
  });

  it("does not start model calls for a paid account", async () => {
    const h = qualificationHost([]);
    h.authority.freeAdmissionVerified = false;
    expect(await productionHandler("providerAccounts:qualify", h.host)({}, h.account.connectionId)).toMatchObject({ ok: false });
    expect(h.host.runRoleAwareQualification).not.toHaveBeenCalled();
  });

  it("binds explicitly authorized paid qualification to one exact model, current workspace and existing durable reservation bridge", async () => {
    const h = qualificationHost([]);
    const authority = { ...h.authority, connectionId: h.account.connectionId, freeAdmissionVerified: false, enabled: true, authState: "ok", accountClass: "PAID", paidSpendingEnabled: true, monthlyBudgetCents: 100 };
    const paidModel = { ...h.model, modelId: "vendor/exact-paid", isFree: false, freeStatus: "paid", pricing: { ...h.model.pricing, inputCostPerMillion: 1, outputCostPerMillion: 2 } };
    const policy = { mode: "FREE_PREFERRED", paidEnabled: true, explicitConsent: true, limitationsAcknowledged: true, automaticTopUp: false };
    const reserve = vi.fn(async () => ({ dispatch: async () => {}, settle: async () => {}, fail: async () => {} }));
    const transportConfig = vi.fn();
    const qualify = vi.fn(async (options: PaidQualificationOptions) => { options.assertCurrent(); await options.reserve({} as never, {} as never); });
    const connections = { ...h.connections, providerAccountAuthority: () => authority, providerAccountModels: () => ({ models: [paidModel] }) };
    const host = { ...h.host, requireConnections: () => connections, server: { reservePersonalAccountQualification: reserve }, currentWorkspacePath: "G:\\public-fixture",
      readSettings: () => ({}), readPersonalProviderRoutingPolicy: () => policy, personalPaidQualificationAdmission,
      connectedAccountRuntimeAuthority: () => authority, qualifyPersonalPaidModel: qualify,
      OpenAICompatibleAdapter: class { constructor(config: unknown) { transportConfig(config); } } };
    const handler = productionHandler("providerAccounts:qualify", host);
    expect(await handler({}, h.account.connectionId)).toMatchObject({ ok: false });
    expect(await handler({}, h.account.connectionId, "vendor/other-model")).toMatchObject({ ok: false });
    expect(qualify).not.toHaveBeenCalled();
    expect(await handler({}, h.account.connectionId, paidModel.modelId)).toMatchObject({ ok: true });
    expect(qualify.mock.calls[0]?.[0]).toMatchObject({ authority, model: paidModel, workspacePath: "G:\\public-fixture" });
    expect(transportConfig).toHaveBeenCalledWith(expect.objectContaining({ providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", includeUsageInStream: true, requestBodyExtras: { usage: { include: true } } }));
    expect(reserve).toHaveBeenCalledOnce(); expect(h.host.runRoleAwareQualification).not.toHaveBeenCalled();
    policy.paidEnabled = false;
    expect(await handler({}, h.account.connectionId, paidModel.modelId)).toMatchObject({ ok: false });
    expect(qualify).toHaveBeenCalledOnce();
  });

  it("preserves provider quota failures as transient qualification evidence", async () => {
    const h = qualificationHost([{ type: "error", code: "RATE_LIMITED", message: "sensitive upstream detail", retryable: true, status: 429, retryAfter: 1_900_000_000_000, rateLimitScope: "provider" }]);
    expect(await productionHandler("providerAccounts:qualify", h.host)({}, h.account.connectionId)).toMatchObject({ ok: false });
    expect(h.failures).toMatchObject([{ code: "RATE_LIMITED", status: 429, rateLimitScope: "provider", retryable: true }]);
    expect(String(h.failures[0])).toMatch(/429/);
    expect(String(h.failures[0])).not.toContain("sensitive upstream detail");
  });
});

describe("production connected-account workspace privacy authority", () => {
  it("binds account authority to the exact currently consented public workspace", () => {
    const account = { ownerUserId: "owner-a", credentialRef: "fixture-private-reference", credentialFingerprint: "fixture-fingerprint" };
    const host = { userConnectedFreeScopeId: () => "owner-a", currentWorkspacePath: "G:\\public-fixture", readAppSettings: () => ({}),
      freeCodeContextForWorkspace: (_settings: unknown, workspace: string) => ({ userConsented: workspace === "G:\\public-fixture" }),
      providerConnections: { providerAccountAuthority: () => account, providerAccountModels: () => ({ ...account, models: [] }) } };
    const authority = productionFunction("connectedAccountRuntimeAuthority", host);
    expect(authority("owner-a", "connection-a")).toMatchObject({ authorizedWorkspacePath: "G:\\public-fixture" });
    expect(authority("owner-b", "connection-a")).toBeUndefined();
    host.currentWorkspacePath = "G:\\private-fixture";
    expect(authority("owner-a", "connection-a")).toBeUndefined();
  });
});

describe("production cloud owner lifecycle", () => {
  it("does not return an old owner's account after a session switch while parsing the response", async () => {
    let owner = "owner-a";
    let accessToken = "fixture-access-a";
    const host = { getStoredCloudTokens: () => ({ accessToken, user: { id: owner } }), userConnectedFreeScopeId: () => owner,
      cloudFetch: vi.fn(async () => ({ status: 200, ok: true, json: async () => { owner = "owner-b"; accessToken = "fixture-access-b"; return { user: { id: "owner-a" } }; } })) };
    expect(await productionFunction("fetchCloudAccountAuthoritative", host)()).toBeNull();
  });

  it("does not restore a refresh response into an account that logged out", async () => {
    let tokens: { accessToken?: string; refreshToken?: string; user?: { id: string } } = { accessToken: "fixture-access-a", refreshToken: "fixture-refresh-a", user: { id: "owner-a" } };
    const saveCloudTokens = vi.fn();
    const host = { getStoredCloudTokens: () => tokens, userConnectedFreeScopeId: () => tokens.user?.id ?? "desktop-profile", saveCloudTokens,
      cloudFetch: vi.fn(async () => { tokens = {}; return { status: 200, ok: true, json: async () => ({ accessToken: "fixture-access-new", refreshToken: "fixture-refresh-new", user: { id: "owner-a" } }) }; }),
      HostedProviderAdapter: class { constructor(readonly options: unknown) {} } };
    const adapter = productionFunction("createCloudAdapter", { ...host, CLOUD_API_URL: "https://cloud.example.invalid" })() as { options: { onAuthExpired: () => Promise<unknown> } };
    expect(await adapter.options.onAuthExpired()).toBeNull();
    expect(saveCloudTokens).not.toHaveBeenCalled();
  });

  it("does not clear a newly signed-in owner's session after an earlier logout response", async () => {
    let accessToken = "fixture-access-a";
    const clearCloudTokens = vi.fn();
    const host = { assertMainWindowSender: vi.fn(), getStoredCloudTokens: () => ({ accessToken, refreshToken: "fixture-refresh" }), clearCloudTokens,
      cloudFetch: vi.fn(async () => { accessToken = "fixture-access-b"; return {}; }) };
    await productionHandler("cloud:auth:logout", host)({});
    expect(clearCloudTokens).not.toHaveBeenCalled();
  });
});
