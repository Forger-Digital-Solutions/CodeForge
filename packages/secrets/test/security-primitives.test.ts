import { describe, expect, it } from "vitest";
import {
  ConsoleSecurityAuditSink,
  MemorySecurityAuditSink,
  SecurityAuditLog,
  createRedactingLogger,
  filterEnv,
  isSensitiveEnvKey,
  redactSecrets,
  redactValue,
  sanitizeSecurityAuditEvent,
} from "../src/index.js";

// Every fixture below is an obviously fake secret. None is a real credential.
const FIXTURES = {
  openrouter: "sk-or-v1-CF_TEST_SECRET_DO_NOT_USE_0123456789abcdef",
  github: "ghp_CFTESTSECRETDONOTUSE0123456789abcdefghij",
  stripe: "sk_test_CFTESTSECRETDONOTUSE0123456789",
  webhook: "whsec_CFTESTSECRETDONOTUSE0123456789",
  refresh: "cfr_CF_TEST_SECRET_DO_NOT_USE_refresh_token_value",
  authCode: "cfa_CF_TEST_SECRET_DO_NOT_USE_desktop_code_value",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyIsInNpZCI6InNlc3MifQ.CFTESTSIGNATUREDONOTUSE0123456789",
  postgres: "postgresql://cf_user:CF_TEST_SECRET_DO_NOT_USE_pw@db.example.internal:5432/codeforge",
  controlToken: "CF_TEST_SECRET_DO_NOT_USE_control_plane_bearer",
  cookie: "__Host-codeforge-session=CF_TEST_SECRET_DO_NOT_USE_cookie_value; Path=/; HttpOnly",
};

describe("redactSecrets — credential shapes (Phase 19)", () => {
  // The bare control-plane bearer has no distinctive shape; it is redacted by header name (below).
  it.each(Object.entries(FIXTURES).filter(([name]) => name !== "controlToken"))("masks %s", (_name, value) => {
    const text = `before ${value} after`;
    const redacted = redactSecrets(text);
    const secretPart = value.includes("=") && value.startsWith("__Host") ? "CF_TEST_SECRET_DO_NOT_USE_cookie_value" : value.split(":").pop()!.split("@")[0]!;
    expect(redacted).not.toContain(secretPart);
    expect(redacted).toContain("[REDACTED]");
  });

  it("masks Authorization and Cookie headers by name", () => {
    expect(redactSecrets(`Authorization: Bearer ${FIXTURES.jwt}`)).not.toContain(FIXTURES.jwt);
    expect(redactSecrets(`cookie: ${FIXTURES.cookie}`)).not.toContain("CF_TEST_SECRET_DO_NOT_USE_cookie_value");
    expect(redactSecrets(`x-codeforge-control-token: ${FIXTURES.controlToken}`)).not.toContain(FIXTURES.controlToken);
  });
});

describe("redactValue — structural redaction for loggers", () => {
  it("blanks sensitive field names anywhere in a structure and pattern-redacts string leaves", () => {
    const input = {
      headers: { authorization: `Bearer ${FIXTURES.jwt}`, cookie: FIXTURES.cookie, "x-codeforge-control-token": FIXTURES.controlToken, accept: "application/json" },
      body: { apiKey: FIXTURES.openrouter, nested: { password: "hunter2", note: `token ${FIXTURES.github}` } },
      databaseUrl: FIXTURES.postgres,
      list: [FIXTURES.stripe, { refresh_token: FIXTURES.refresh }],
      error: Object.assign(new Error(`upstream said ${FIXTURES.webhook}`), { code: "E_UPSTREAM" }),
      url: new URL("https://user:CF_TEST_SECRET_DO_NOT_USE_urlpw@example.com/path"),
    };
    const out = JSON.stringify(redactValue(input));
    for (const value of Object.values(FIXTURES)) {
      const secretPart = value.startsWith("__Host") ? "CF_TEST_SECRET_DO_NOT_USE_cookie_value" : value.split(":").pop()!.split("@")[0]!;
      expect(out, secretPart).not.toContain(secretPart);
    }
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("CF_TEST_SECRET_DO_NOT_USE_urlpw");
    expect(out).toContain('"accept":"application/json"');
    expect(out).toContain('"code":"E_UPSTREAM"');
  });

  it("bounds depth, arrays, and strings and never throws on exotic values", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(() => redactValue(deep)).not.toThrow();
    expect(JSON.stringify(redactValue(deep))).toContain("[depth-limit]");
    expect(JSON.stringify(redactValue(Buffer.from("secret")))).toContain("[binary 6 bytes]");
    expect((redactValue("x".repeat(10_000)) as string).length).toBeLessThan(5000);
    expect((redactValue(new Array(500).fill("a")) as unknown[]).length).toBe(100);
  });
});

describe("createRedactingLogger", () => {
  it("emits JSON lines with every field redacted at the boundary", () => {
    const lines: string[] = [];
    const logger = createRedactingLogger({ name: "test", level: "debug", write: (_level, line) => lines.push(line), now: () => new Date("2026-09-18T00:00:00Z") });
    logger.info(`login for ${FIXTURES.github}`, { headers: { authorization: `Bearer ${FIXTURES.jwt}` }, refreshToken: FIXTURES.refresh, ok: true });
    logger.child({ requestId: "r-1", cookie: FIXTURES.cookie }).error("failed", { error: new Error(FIXTURES.postgres) });
    const joined = lines.join("\n");
    for (const value of Object.values(FIXTURES)) {
      const secretPart = value.startsWith("__Host") ? "CF_TEST_SECRET_DO_NOT_USE_cookie_value" : value.split(":").pop()!.split("@")[0]!;
      expect(joined, secretPart).not.toContain(secretPart);
    }
    expect(lines[0]).toContain('"level":"info"');
    expect(lines[0]).toContain('"ok":true');
    expect(lines[1]).toContain('"requestId":"r-1"');
    expect(lines[1]).toContain('"cookie":"[REDACTED]"');
  });

  it("respects the level threshold and silent mode", () => {
    const lines: string[] = [];
    const logger = createRedactingLogger({ level: "warn", write: (_l, line) => lines.push(line) });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    expect(lines).toHaveLength(1);
    logger.level = "silent";
    logger.error("e");
    expect(lines).toHaveLength(1);
  });
});

describe("SecurityAuditLog", () => {
  it("records sanitized events, counts them, and survives a throwing sink", () => {
    const memory = new MemorySecurityAuditSink();
    const consoleLines: string[] = [];
    const log = new SecurityAuditLog([
      { record: () => { throw new Error("sink down"); } },
      { record: () => Promise.reject(new Error("async sink down")) },
      memory,
      new ConsoleSecurityAuditSink((line) => consoleLines.push(line)),
    ]);
    expect(() =>
      log.emit({ type: "auth.login.failed", outcome: "failure", userId: "user-1", ipAddress: "203.0.113.5", details: { reason: `bad token ${FIXTURES.jwt}`, attempt: 3, flag: true, drop: undefined as unknown as null } }),
    ).not.toThrow();
    log.emit({ type: "auth.login.succeeded", outcome: "success", userId: "user-1" });
    expect(memory.events).toHaveLength(2);
    expect(memory.events[0]!.details).toEqual({ reason: expect.stringContaining("[REDACTED]"), attempt: 3, flag: true });
    expect(JSON.stringify(memory.events)).not.toContain(FIXTURES.jwt.split(".")[2]);
    expect(consoleLines[0]).toMatch(/^\[security-audit\] \{/);
    expect(log.snapshot()).toEqual({ "auth.login.failed:failure": 1, "auth.login.succeeded:success": 1 });
  });

  it("bounds detail size and key count", () => {
    const details: Record<string, string> = {};
    for (let i = 0; i < 40; i++) details[`k${i}`] = "v".repeat(1000);
    const safe = sanitizeSecurityAuditEvent({ type: "request.rejected", outcome: "denied", details });
    expect(Object.keys(safe.details ?? {})).toHaveLength(16);
    expect((safe.details!.k0 as string).length).toBeLessThanOrEqual(256);
    expect(safe.occurredAt).toBeDefined();
  });
});

describe("child-process environment filter (Phase 13)", () => {
  it("strips every control-plane and provider credential name CodeForge uses", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/cf",
      OPENROUTER_API_KEY: "x",
      GROQ_API_KEY: "x",
      GEMINI_API_KEY: "x",
      ZHIPU_API_KEY: "x",
      CLOUDFLARE_API_KEY: "x",
      CLOUDFLARE_ACCOUNT_ID: "x",
      GITHUB_CLIENT_SECRET: "x",
      GITHUB_APP_PRIVATE_KEY: "x",
      JWT_SECRET: "x",
      DATABASE_URL: "x",
      PGPASSWORD: "x",
      STRIPE_SECRET_KEY: "x",
      STRIPE_WEBHOOK_SECRET: "x",
      STRIPE_PRO_PRICE_ID: "x",
      CODEFORGE_DATA_ENCRYPTION_KEYS: "x",
      CODEFORGE_LOCAL_CONTROL_TOKEN: "x",
      SUPABASE_SERVICE_ROLE: "x",
      SENTRY_DSN: "x",
      NODE_AUTH_TOKEN: "x",
      MY_APP_ENCRYPTION_KEY: "x",
      TOKENIZERS_PARALLELISM: "false",
      CODEFORGE_CLOUD_ENV: "development",
      NODE_ENV: "test",
    };
    const filtered = filterEnv(env);
    expect(Object.keys(filtered).sort()).toEqual(["CODEFORGE_CLOUD_ENV", "HOME", "NODE_ENV", "PATH"]);
    for (const key of Object.keys(env)) {
      if (!(key in filtered)) expect(isSensitiveEnvKey(key), key).toBe(true);
    }
  });
});
