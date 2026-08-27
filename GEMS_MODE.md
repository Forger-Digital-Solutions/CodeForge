# CodeForge GEMS Mode

## Overview

GEMS (Global Enterprise Model Service) is CodeForge's premium tier for subscribed users. It provides access to higher-quality paid models while maintaining the fail-closed safety model.

---

## What is GEMS?

GEMS models are premium models (like GPT-4, Claude 3.5) that:
- Require active subscription or trial
- Are entitlement-gated before every turn
- Never appear in auto-routing (ForgeZero adaptive)
- Must be explicitly selected by the user

---

## Architecture

### GEMS Guard (packages/gems/)

```typescript
class GemsGuard {
  constructor(firewall: ForgeZero) {}
  
  // Data classification
  classifyData(content: string): DataClassification;
  
  // External inference policy
  checkInferencePolicy(model: FreeModelRecord, classification: DataClassification): {
    allowed: boolean;
    requiresApproval: boolean;
  };
}
```

### Entitlement Provider

```typescript
interface EntitlementProvider {
  check(userId: string, providerId: string, modelId: string): Promise<EntitlementResult>;
  health(): Promise<{ healthy: boolean; latency?: number }>;
}
```

---

## Entitlement Flow

### 1. User Selects GEMS Model

```typescript
// User explicitly selects a GEMS model in UI
const selection = {
  type: "exact-premium",
  providerId: "openrouter",
  modelId: "gpt-4-turbo",
  tier: "paid"
};

// Model selection endpoint validates
if (model.tier === "gems_paid") {
  // Defer to turn execution for entitlement check
  runtime.setModelSelection(selection);
}
```

### 2. Turn Execution Gates

```typescript
// In executeTurn()
if (model.tier === "gems_paid") {
  const entitlement = await this.firewall.checkEntitlement(
    this.userId,
    model.providerId,
    model.modelId
  );
  
  if (!entitlement.ok) {
    throw new Error(`[${entitlement.error.code}] ${entitlement.error.message}`);
  }
}

// Only proceed if entitled
await this.simulateAgentWork(turnId, ...);
```

### 3. Entitlement Check

```typescript
// ForgeZero.checkEntitlement()
async checkEntitlement(userId: string, providerId: string, modelId: string): Promise<{
  ok: boolean;
  error?: { code: string; message: string };
}> {
  const model = this.getModel(providerId, modelId);
  if (!model) {
    return { ok: false, error: { code: "NOT_FOUND", message: "Model not found" } };
  }
  
  if (model.tier !== "gems_paid") {
    return { ok: true }; // Free models always allowed
  }
  
  if (!this.entitlementProvider) {
    return { ok: false, error: { code: "NO_PROVIDER", message: "Entitlement service unavailable" } };
  }
  
  return this.entitlementProvider.check(userId, providerId, modelId);
}
```

---

## Entitlement Providers

### DevelopmentEntitlementProvider

Default for development/testing:

```typescript
function createDevelopmentEntitlementProvider(): EntitlementProvider {
  return {
    async check(userId, providerId, modelId) {
      // Development entitlement scenarios
      const user: Record<string, string> = {
        "free-user": "free",
        "trial-user": "trial",
        "paid-user": "paid",
      };
      
      const tier = user[userId] ?? "anonymous";
      
      if (tier === "free" || tier === "anonymous") {
        return {
          ok: false,
          error: { code: "REQUIRES_SUBSCRIPTION", message: "This model requires a subscription" }
        };
      }
      
      return { ok: true };
    },
    
    async health() {
      return { healthy: true };
    }
  };
}
```

### Production Provider (Not Yet Implemented)

Would integrate with CodeForge backend:
```typescript
class CodeForgeEntitlementProvider implements EntitlementProvider {
  async check(userId: string, providerId: string, modelId: string): Promise<EntitlementResult> {
    const response = await fetch(`https://api.codeforge.dev/entitlement/${userId}`, {
      headers: { "Authorization": `Bearer ${this.apiKey}` }
    });
    
    if (!response.ok) {
      return { ok: false, error: { code: "SERVICE_ERROR", message: "Entitlement check failed" } };
    }
    
    const data = await response.json();
    return { ok: data.entitled.includes(modelId) };
  }
}
```

---

## Testing Entitlement

### Test Scenarios

```typescript
// packages/forge-zero/test/forge-zero.test.ts
describe("ForgeZero — entitlement checks", () => {
  it("[PASS] free user + free model → allowed", async () => {
    const result = await firewall.checkEntitlement("free-user", "codeforge", "free-model-1");
    expect(result.ok).toBe(true);
  });
  
  it("[PASS] free user + GEMS model → requires subscription (denied)", async () => {
    const result = await firewall.checkEntitlement("free-user", "openrouter", "gpt-4");
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("REQUIRES_SUBSCRIPTION");
  });
  
  it("[PASS] paid user + GEMS model → included", async () => {
    const result = await firewall.checkEntitlement("paid-user", "openrouter", "gpt-4");
    expect(result.ok).toBe(true);
  });
  
  it("[PASS] entitlement provider failure → deny (fail closed)", async () => {
    const firewall = new ForgeZero({
      entitlementProvider: new FailingEntitlementProvider()
    });
    
    const result = await firewall.checkEntitlement("paid-user", "openrouter", "gpt-4");
    expect(result.ok).toBe(false);
  });
});
```

### Integration Tests

```typescript
// packages/server/test/entitlement-enforcement.test.ts
it("denies a free user selecting a GEMS paid model (REQUIRES_SUBSCRIPTION)", async () => {
  const server = new CodeForgeServer({ port: 0 });
  
  // Set GEMS model selection
  await fetch(`http://localhost:${server.httpPort}/api/model-selection`, {
    method: "POST",
    body: JSON.stringify({
      sessionId: "test-session",
      providerId: "openrouter",
      modelId: "gpt-4-turbo"
    })
  });
  
  // Attempt turn
  const response = await fetch(`http://localhost:${server.httpPort}/api/send`, {
    method: "POST",
    body: JSON.stringify({
      sessionId: "test-session",
      userId: "free-user",
      message: "Test message"
    })
  });
  
  // Turn fails with entitlement error
  const session = await fetch(`http://localhost:${server.httpPort}/api/sessions/test-session`);
  const data = await session.json();
  
  expect(data.turns[0].status).toBe("failed");
  expect(data.turns[0].error).toContain("REQUIRES_SUBSCRIPTION");
});
```

---

## Fail-Closed Guarantees

### Entitlement Service Unavailable

```typescript
// ForgeZero.checkEntitlement()
if (entitlementProvider && !entitlementProviderHealth.healthy) {
  return {
    ok: false,
    error: { code: "SERVICE_UNHEALTHY", message: "Entitlement service unavailable" }
  };
}
```

### Network Failures

```typescript
try {
  const result = await entitlementProvider.check(userId, providerId, modelId);
} catch (error) {
  return {
    ok: false,
    error: { code: "SERVICE_ERROR", message: "Entitlement check failed" }
  };
}
```

### Unknown User

```typescript
if (!userId || userId === "anonymous") {
  return {
    ok: false,
    error: { code: "AUTHENTICATION_REQUIRED", message: "Please sign in to use premium models" }
  };
}
```

---

## Model Registration

### Free Models

```typescript
firewall.register({
  providerId: "codeforge",
  modelId: "free-model-1",
  tier: "free",  // Always accessible
  inputCost: 0,
  outputCost: 0,
});
```

### GEMS Models

```typescript
firewall.register({
  providerId: "openrouter",
  modelId: "gpt-4-turbo",
  tier: "gems_paid",  // Requires entitlement
  inputCost: 10,  // $/1M tokens
  outputCost: 30,
});
```

---

## Current Limitations

1. **No production entitlement service** — Development provider only
2. **No subscription management** — User tiers are hardcoded
3. **No trial period tracking** — Trial expiration not implemented
4. **No usage metering** — Token usage not tracked or billed
5. **No model-specific policies** — All GEMS models have same policy

## Future Work

- Production entitlement service integration
- Subscription management UI
- Trial period enforcement
- Usage tracking and billing
- Model-specific rate limiting
- Cost tracking per turn
