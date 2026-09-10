import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeZero } from "../packages/forge-zero/dist/index.js";
import {
  CodexAccountAdapter,
  CodexAppServerProcess,
  InMemoryProviderCatalog,
} from "../packages/providers/dist/index.js";
import { CodeForgeServer } from "../packages/server/dist/index.js";

const TURN_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 200;
const LIVE_RESPONSE = "CODEFORGE_CODEX_LIVE_OK";
const APPROVAL_RESPONSE = "CODEFORGE_CODEX_APPROVAL_OK";
const APPROVED_CONTENT = "CODEFORGE_APPROVAL_EXECUTED_ONCE";
const observedNotifications = new Map();
const observedServerRequests = [];
let lastSessionDiagnostic = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonRequest(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function postJson(base, pathname, body) {
  return jsonRequest(base, pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForSession(base, sessionId, predicate, description) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await jsonRequest(base, `/api/sessions/${sessionId}`);
    if (response.status === 200) {
      lastSessionDiagnostic = {
        sessionStatus: response.body?.session?.status ?? null,
        turnStatuses: (response.body?.turns ?? []).map((turn) => turn.status),
        pendingApprovalCount: response.body?.pendingApprovals?.length ?? 0,
        eventTypes: [...new Set((response.body?.events ?? []).map((event) => event.type))],
      };
      if (predicate(response.body)) return response.body;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function assistantText(snapshot) {
  return (snapshot.events ?? [])
    .filter((event) => event.type === "assistant.message.completed")
    .map((event) => event.payload?.text ?? "")
    .join("\n");
}

function terminalTurn(snapshot, turnId) {
  return (snapshot.turns ?? []).find((turn) => turn.id === turnId
    && ["completed", "failed", "cancelled"].includes(turn.status));
}

function codexModelRecord() {
  const now = new Date().toISOString();
  return {
    providerId: "codex-account",
    modelId: "default",
    displayName: "OpenAI Codex · ChatGPT account",
    freeStatus: "verified_free",
    freeStatusVerifiedAt: now,
    lastVerified: now,
    verificationSource: "account/rateLimits/read",
    tier: "free",
    accessClass: "FREE_ALLOWANCE",
    authMode: "ACCOUNT_CONNECT",
    privacyClass: "standard",
    contextWindow: 128000,
    capabilities: {
      text: true,
      coding: true,
      toolCalling: true,
      vision: false,
      structuredOutput: false,
      longContext: true,
    },
    costProfile: {
      inputCostPerMillion: null,
      outputCostPerMillion: null,
      isFree: false,
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "codex-account:rate-limits",
      freeTierVerifiedAt: now,
      freeQuotaDescription: "ChatGPT Codex account allowance",
    },
    isRemote: true,
    isCloudHosted: true,
    health: { status: "available", lastCheckedAt: now },
  };
}

const ownedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-r6-live-"));
const workspacePath = path.join(ownedRoot, "workspace");
const dbPath = path.join(ownedRoot, "codeforge.db");
const approvedPath = path.join(workspacePath, "r6-approved.txt");
await fs.mkdir(workspacePath, { recursive: true });
await fs.writeFile(path.join(workspacePath, "r6-live-smoke.txt"), "CODEFORGE_LIVE_FIXTURE", "utf8");

let adapter;
let server;
const transport = new CodexAppServerProcess({
  cwd: workspacePath,
  onStderr: () => undefined,
  onNotification: (notification) => {
    observedNotifications.set(
      notification.method,
      (observedNotifications.get(notification.method) ?? 0) + 1,
    );
  },
  onServerRequest: (request) => {
    observedServerRequests.push({
      method: request.method,
      paramKeys: Object.keys(request.params ?? {}).sort(),
      namespace: typeof request.params?.namespace === "string" ? request.params.namespace : null,
      tool: typeof request.params?.tool === "string" ? request.params.tool : null,
    });
    return adapter.handleServerRequest(request);
  },
});

try {
  adapter = new CodexAccountAdapter({
    transport,
    toolExecutor: (request) => server.executeProviderTool(request),
  });
  const account = await adapter.readAccount();
  if (!account) throw new Error("Codex account is not authenticated");
  const limits = await adapter.readRateLimits();
  if (adapter.routeState !== "allowance_available") {
    throw new Error(`Codex allowance is unavailable: ${adapter.routeState}`);
  }

  const firewall = new ForgeZero();
  firewall.register(codexModelRecord());
  const catalog = new InMemoryProviderCatalog();
  catalog.register(adapter);
  server = new CodeForgeServer({
    port: 0,
    dbPath,
    firewall,
    providerCatalog: catalog,
    useRealRuntime: true,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort}`;
  const workspace = await postJson(base, "/api/workspace/set", { path: workspacePath });
  if (workspace.status !== 200) throw new Error(`Workspace setup failed: HTTP ${workspace.status}`);

  const liveSessionId = `r6-live-${crypto.randomUUID()}`;
  const liveSelection = await postJson(base, "/api/model-selection", {
    sessionId: liveSessionId,
    providerId: "codex-account",
    modelId: "default",
  });
  if (liveSelection.status !== 200) throw new Error(`Codex selection failed: HTTP ${liveSelection.status}`);
  const liveStarted = await postJson(base, "/api/send", {
    sessionId: liveSessionId,
    executionMode: "chat",
    message: `Reply with exactly: ${LIVE_RESPONSE}`,
  });
  if (liveStarted.status !== 200 || !liveStarted.body?.turnId) {
    throw new Error(`Live Codex turn failed to start: HTTP ${liveStarted.status}`);
  }
  const liveSnapshot = await waitForSession(
    base,
    liveSessionId,
    (snapshot) => Boolean(terminalTurn(snapshot, liveStarted.body.turnId)),
    "the live Codex turn",
  );
  const liveTurn = terminalTurn(liveSnapshot, liveStarted.body.turnId);
  const liveText = assistantText(liveSnapshot);
  if (liveTurn?.status !== "completed" || !liveText.includes(LIVE_RESPONSE)) {
    throw new Error(`Live Codex turn did not return the expected marker (${liveTurn?.status ?? "missing"})`);
  }

  const approvalSessionId = `r6-approval-${crypto.randomUUID()}`;
  const approvalSelection = await postJson(base, "/api/model-selection", {
    sessionId: approvalSessionId,
    providerId: "codex-account",
    modelId: "default",
  });
  if (approvalSelection.status !== 200) throw new Error(`Approval Codex selection failed: HTTP ${approvalSelection.status}`);
  const approvalStarted = await postJson(base, "/api/send", {
    sessionId: approvalSessionId,
    executionMode: "chat",
    message: `Use the codeforge write_file tool to create r6-approved.txt with exactly ${APPROVED_CONTENT}. Do not use a shell or a built-in tool. After the tool succeeds, reply with exactly: ${APPROVAL_RESPONSE}`,
  });
  if (approvalStarted.status !== 200 || !approvalStarted.body?.turnId) {
    throw new Error(`Approval turn failed to start: HTTP ${approvalStarted.status}`);
  }

  const pendingSnapshot = await waitForSession(
    base,
    approvalSessionId,
    (snapshot) => (snapshot.pendingApprovals?.length ?? 0) === 1
      || Boolean(terminalTurn(snapshot, approvalStarted.body.turnId)),
    "the CodeForge approval request",
  );
  if ((pendingSnapshot.pendingApprovals?.length ?? 0) !== 1) {
    const ended = terminalTurn(pendingSnapshot, approvalStarted.body.turnId);
    throw new Error(`Live Codex did not produce one approval request (${ended?.status ?? "unknown"})`);
  }
  try {
    await fs.stat(approvedPath);
    throw new Error("The live tool executed before CodeForge approval");
  } catch (error) {
    if (error instanceof Error && error.message === "The live tool executed before CodeForge approval") throw error;
  }

  const approval = pendingSnapshot.pendingApprovals[0];
  const approvalRecord = (pendingSnapshot.workItems ?? []).find(
    (item) => item.kind === "approval" && item.id === approval.approvalId,
  );
  const correlation = approvalRecord?.correlation;
  const requiredCorrelation = [
    "providerId",
    "processSessionId",
    "codeForgeSessionId",
    "codeForgeTurnId",
    "providerThreadId",
    "providerTurnId",
    "serverRequestId",
    "providerToolCallId",
    "intendedAction",
  ];
  if (!correlation || requiredCorrelation.some((key) => typeof correlation[key] !== "string" || correlation[key].length === 0)) {
    throw new Error("Live approval correlation was incomplete");
  }

  const resolved = await postJson(base, `/api/approvals/${approval.approvalId}/resolve`, {
    decision: "allow_once",
  });
  if (resolved.status !== 200) throw new Error(`Approval resolution failed: HTTP ${resolved.status}`);
  const duplicate = await postJson(base, `/api/approvals/${approval.approvalId}/resolve`, {
    decision: "allow_once",
  });
  if (duplicate.status !== 200 && duplicate.status !== 404) {
    throw new Error(`Duplicate live approval response failed unexpectedly: HTTP ${duplicate.status}`);
  }

  const approvalSnapshot = await waitForSession(
    base,
    approvalSessionId,
    (snapshot) => Boolean(terminalTurn(snapshot, approvalStarted.body.turnId)),
    "the approved live Codex turn",
  );
  const approvalTurn = terminalTurn(approvalSnapshot, approvalStarted.body.turnId);
  const approvalText = assistantText(approvalSnapshot);
  const approvedContent = await fs.readFile(approvedPath, "utf8");
  const approvedExecutionCount = (approvalSnapshot.events ?? []).filter(
    (event) => event.type === "tool.execution_started"
      && event.payload?.toolName === "write_file",
  ).length;
  if (approvalTurn?.status !== "completed"
    || approvedContent !== APPROVED_CONTENT
    || approvedExecutionCount !== 1
    || !approvalText.includes(APPROVAL_RESPONSE)) {
    throw new Error(`Approved live Codex turn did not complete correctly (${approvalTurn?.status ?? "missing"})`);
  }

  console.log(JSON.stringify({
    authenticated: true,
    authMode: account.authMode,
    planType: account.planType ?? null,
    allowanceState: adapter.routeState,
    rateLimitWindows: limits.length,
    selectedProvider: "codex-account",
    selectedModel: "default",
    liveTurn: "PASS",
    liveMarker: liveText.includes(LIVE_RESPONSE),
    approvalRequested: true,
    approvalCorrelation: "complete",
    sideEffectBeforeApproval: false,
    duplicateApprovalResponseStatus: duplicate.status,
    approvedExecutionCount,
    approvedFileContent: approvedContent,
    approvalTurn: "PASS",
    approvalResponseMarker: approvalText.includes(APPROVAL_RESPONSE),
    paidFallbackPossible: false,
  }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CODEFORGE_R6_LIVE_RUNTIME_FAILED: ${message}`);
  console.error(JSON.stringify({
    observedNotifications: Object.fromEntries(observedNotifications),
    observedServerRequests,
    lastSessionDiagnostic,
    transportState: transport.snapshot.state,
  }));
  process.exitCode = 1;
} finally {
  if (server) await server.stop();
  await transport.close();
  await fs.rm(ownedRoot, { recursive: true, force: true });
}
