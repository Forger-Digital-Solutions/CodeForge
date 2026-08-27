# CodeForge Router

## Overview

The router (`@codeforge/router`) selects the appropriate model for each task based on task requirements, model capabilities, and ForgeZero eligibility. It enforces the fail-closed safety model.

---

## Components

### ForgeRouter

```typescript
class ForgeRouter {
  constructor(options: {
    firewall: ForgeZero;
    registry: FreeModelRegistry;
  });
  
  route(request: RoutingRequest): Promise<RoutingDecision>;
  resolveSelection(selection: ExecutionModelSelection): FreeModelRecord | null;
}
```

### RoutingRequest

```typescript
interface RoutingRequest {
  task: TaskDefinition;
  constraints?: {
    requiresToolCalling?: boolean;
    requiresVision?: boolean;
    requiresCoding?: boolean;
    maxContextWindow?: number;
  };
}
```

### RoutingDecision

```typescript
interface RoutingDecision {
  model: FreeModelRecord;
  provider: ProviderAdapter;
  reasoning: string[];
  alternatives: FreeModelRecord[];
}
```

---

## Model Selection Modes

### ForgeZero Adaptive (Auto)

```typescript
type ExecutionModelSelection = 
  | { type: "forgezero-adaptive" }
  | { type: "exact-free"; providerId: string; modelId: string }
  | { type: "exact-premium"; providerId: string; modelId: string; family: "gpt" | "anthropic" | "glm" }
  | { type: "gems" };
```

**Adaptive mode:**
- Router selects from `firewall.eligibleModels()`
- Prioritizes coding capability and tool calling
- Always returns verified-free models
- No user input required

### Exact Free

User explicitly selects a free model:
- Router validates model exists in ForgeZero registry
- Validates cost is zero
- Fails if model not found or not free

### Exact Premium

User selects a paid model (GPT, Anthropic, GLM):
- Router validates provider has credential
- ForgeZero checks entitlement before execution
- Family isolation enforced (GPT never falls back to Anthropic)

---

## Routing Algorithm

```typescript
async route(request: RoutingRequest): Promise<RoutingDecision> {
  // 1. Get eligible models from ForgeZero
  const eligible = this.firewall.eligibleModels();
  
  if (eligible.length === 0) {
    throw new Error("No eligible free models available");
  }
  
  // 2. Score by capabilities
  const scored = eligible.map(model => ({
    model,
    score: this.scoreModel(model, request),
  }));
  
  // 3. Sort by score (descending)
  scored.sort((a, b) => b.score - a.score);
  
  // 4. Return best match with alternatives
  return {
    model: scored[0].model,
    provider: this.catalog.get(scored[0].model.providerId)!,
    reasoning: this.explainScore(scored[0].model),
    alternatives: scored.slice(1, 4).map(s => s.model),
  };
}
```

### Scoring

```typescript
scoreModel(model: FreeModelRecord, request: RoutingRequest): number {
  let score = 0;
  
  // Capability matching
  if (request.constraints?.requiresCoding && model.capabilities.coding) score += 30;
  if (request.constraints?.requiresToolCalling && model.capabilities.toolCalling) score += 25;
  if (request.constraints?.requiresVision && model.capabilities.vision) score += 20;
  
  // Context window
  if (request.constraints?.maxContextWindow) {
    if (model.contextWindow >= request.constraints.maxContextWindow) {
      score += 15;
    }
  }
  
  // Base quality score (from registry)
  score += model.qualityScore ?? 0;
  
  return score;
}
```

---

## Integration with ForgeZero

### Model Registration

```typescript
// packages/server/src/index.ts
private registerFreeModels(): void {
  const model: FreeModelRecord = {
    providerId: "codeforge",
    modelId: "free-model-1",
    displayName: "CodeForge Free Model",
    freeStatus: "verified_free",
    contextWindow: 128000,
    capabilities: {
      text: true,
      coding: true,
      toolCalling: true,
      vision: false,
      structuredOutput: true,
      longContext: true,
    },
    tier: "free",
    inputCost: 0,
    outputCost: 0,
    verifiedAt: new Date().toISOString(),
  };
  
  this.firewall.register(model);
}
```

### Verification Before Routing

```typescript
resolveSelection(selection: ExecutionModelSelection): FreeModelRecord | null {
  if (selection.type === "forgezero-adaptive") {
    return this.selectAdaptive();
  }
  
  const model = this.firewall.getModel(selection.providerId, selection.modelId);
  if (!model) {
    return null; // Not found, fail closed
  }
  
  return model;
}
```

---

## Tier Isolation

### Cross-Tier Prevention

```typescript
// packages/director/test/tier-isolation.test.ts
it("ForgeZero never escalates to premium", () => {
  const director = new ForgeDirector({ firewall, router });
  
  // Adaptive mode never returns paid models
  const result = director.runTask({ selection: { type: "forgezero-adaptive" } });
  
  expect(result.model.tier).toBe("free");
});
```

### Family Isolation

```typescript
it("GPT never invokes Anthropic adapter", () => {
  const gptSelection = { type: "exact-premium", family: "gpt" };
  
  const result = director.runTask({ selection: gptSelection });
  
  expect(result.providerId).toBe("openrouter");
  expect(result.modelId).toContain("gpt");
  // Anthropic provider never called
});
```

---

## Selection via Server API

### Model Selection Endpoint

```typescript
// POST /api/model-selection
{
  "sessionId": "session-123",
  "providerId": "openrouter",
  "modelId": "free-model-1"
}

// Response
{
  "ok": true,
  "selection": {
    "providerId": "openrouter",
    "modelId": "free-model-1",
    "tier": "free"
  }
}
```

### Auto Selection

```typescript
// POST /api/model-selection
{
  "sessionId": "session-123",
  "modelId": "auto"
}

// Response
{
  "ok": true,
  "selection": {
    "modelId": "auto"
  }
}
```

---

## UI Integration

### ModelSelector Component

```typescript
// packages/ui/src/components/ModelSelector.tsx
function ModelSelector({ onSelection }: { onSelection: (selection: ModelSelection) => void }) {
  const [models, setModels] = useState<DisplayModel[]>([]);
  
  useEffect(() => {
    fetch("/api/models")
      .then(res => res.json())
      .then(data => setModels(data.models));
  }, []);
  
  return (
    <select onChange={e => onSelection(JSON.parse(e.target.value))}>
      <option value='{"type":"forgezero-adaptive"}'>Auto (Free)</option>
      {models.map(m => (
        <option key={m.id} value={JSON.stringify({ type: "exact-free", ...m })}>
          {m.displayName} ({m.tier})
        </option>
      ))}
    </select>
  );
}
```

---

## Testing

### Unit Tests

```typescript
// packages/router/test/router.test.ts
describe("ForgeRouter", () => {
  it("selects only verified-free models", async () => {
    const decision = await router.route({ task });
    
    expect(decision.model.freeStatus).toBe("verified_free");
    expect(decision.model.tier).toBe("free");
  });
  
  it("fails when no models available", async () => {
    firewall.eligibleModels.mockReturnValue([]);
    
    await expect(router.route({ task })).rejects.toThrow("No eligible");
  });
});
```

### Integration Tests

```typescript
// packages/director/test/e2e-integration.test.ts
it("traces ForgeZero Adaptive from selection to execution", async () => {
  const result = await director.runTask({
    selection: { type: "forgezero-adaptive" },
    task: { prompt: "Write a function" },
  });
  
  expect(result.status).toBe("completed");
  expect(result.model.tier).toBe("free");
});
```

---

## Current Limitations

1. **Single scoring algorithm** — No task-specific routing
2. **No latency awareness** — Doesn't prefer faster providers
3. **No usage tracking** — Can't balance load across models
4. **No fallback chain** — Single model selection
