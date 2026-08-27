# CodeForge Providers

## Overview

The providers package (`@codeforge/providers`) defines the abstraction layer between CodeForge and LLM backends. All model inference flows through this interface, enabling provider swapping, mock testing, and production isolation.

---

## Provider Adapter Interface

```typescript
interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  
  // Core operations
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  listModels(): Promise<ProviderModel[]>;
  healthCheck(): Promise<ProviderHealth>;
}
```

### ChatRequest

```typescript
interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}
```

### ChatMessage

```typescript
type ChatMessage = 
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };
```

### StreamEvent

```typescript
type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_started"; toolCallId: string; toolName: string }
  | { type: "tool_call_delta"; delta: string }
  | { type: "tool_call_completed"; toolCallId: string; toolName: string; arguments: string }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number; totalTokens?: number } }
  | { type: "finish"; finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error" }
  | { type: "error"; code: string; message: string };
```

---

## Provider Catalog

The registry for available providers:

```typescript
class InMemoryProviderCatalog implements ProviderCatalog {
  private providers: Map<string, ProviderAdapter> = new Map();
  
  register(adapter: ProviderAdapter): void;
  get(providerId: string): ProviderAdapter | undefined;
  getAll(): ProviderAdapter[];
  has(providerId: string): boolean;
}
```

### Server Usage

```typescript
// packages/server/src/index.ts
this.providerCatalog = new InMemoryProviderCatalog();

// Register provider (production: OpenRouter)
if (this.useRealRuntime) {
  const openRouter = new OpenRouterAdapter(process.env.OPENROUTER_API_KEY);
  this.providerCatalog.register(openRouter);
}
```

---

## Implemented Providers

### OpenRouterAdapter

```typescript
class OpenRouterAdapter implements ProviderAdapter {
  readonly id = "openrouter";
  readonly name = "OpenRouter";
  
  constructor(apiKey: string);
  
  async listModels(): Promise<ProviderModel[]>;
  async chat(request: ChatRequest): Promise<ChatResponse>;
  async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  async healthCheck(): Promise<ProviderHealth>;
}
```

**Configuration:**
- API key via `OPENROUTER_API_KEY` environment variable
- Base URL: `https://openrouter.ai/api/v1`
- Supports tool calling and streaming

### Mock Providers (Testing)

```typescript
// packages/providers/src/mock-provider.ts
function createMockProvider(options: {
  id?: string;
  responses?: ChatResponse[];
  models?: ProviderModel[];
}): ProviderAdapter;
```

Used for unit tests to isolate from external services.

### ScriptedTestProvider

```typescript
class ScriptedTestProvider implements ProviderAdapter {
  constructor(scripts: Map<string, ChatResponse>);
  
  // Pre-programmed responses for deterministic testing
  script(request: ChatRequest): ChatResponse;
}
```

---

## Credential Management

### EnvironmentCredentialStore

```typescript
class EnvironmentCredentialStore {
  has(providerId: string): boolean;
  get(providerId: string): string | undefined;
}
```

**Environment variable convention:**
- OpenRouter: `OPENROUTER_API_KEY`
- Future providers: `{PROVIDER_ID}_API_KEY`

### Security

Providers never log credentials:
```typescript
// packages/director/test/security.test.ts
it("never includes API keys in error messages", () => {
  // Error messages redact sensitive values
});
```

---

## Production Safety

### Test Provider Isolation

```typescript
class TestProviderIsolationError extends Error {
  constructor(providerId: string) {
    super(`Test provider '${providerId}' registered in production mode`);
  }
}
```

The catalog rejects test providers when `NODE_ENV=production`:

```typescript
register(adapter: ProviderAdapter): void {
  if (process.env.NODE_ENV === "production" && isTestProvider(adapter)) {
    throw new TestProviderIsolationError(adapter.id);
  }
  this.providers.set(adapter.id, adapter);
}
```

---

## Provider Model Metadata

```typescript
interface ProviderModel {
  id: string;
  providerId: string;
  displayName: string;
  contextWindow: number;
  capabilities: {
    text: boolean;
    coding: boolean;
    toolCalling: boolean;
    vision: boolean;
    structuredOutput: boolean;
    longContext: boolean;
  };
  tier: "free" | "paid" | "gems_paid";
  inputCost?: number;   // per 1M tokens
  outputCost?: number;  // per 1M tokens
}
```

### Integration with ForgeZero

Providers register models with ForgeZero:

```typescript
const model: ProviderModel = {
  id: "free-model-1",
  providerId: "openrouter",
  tier: "free",
  inputCost: 0,
  outputCost: 0,
  // ...
};

firewall.register(model);
```

ForgeZero validates cost and free status before routing.

---

## Adding a New Provider

1. **Create adapter:**
```typescript
// packages/providers/src/new-provider-adapter.ts
export class NewProviderAdapter implements ProviderAdapter {
  readonly id = "newprovider";
  readonly name = "New Provider";
  
  // Implement all interface methods
}
```

2. **Export from package:**
```typescript
// packages/providers/src/index.ts
export { NewProviderAdapter } from "./new-provider-adapter.js";
```

3. **Register with ForgeZero:**
```typescript
// packages/server/src/index.ts
import { NewProviderAdapter } from "@codeforge/providers";

if (process.env.NEWPROVIDER_API_KEY) {
  const provider = new NewProviderAdapter(process.env.NEWPROVIDER_API_KEY);
  this.providerCatalog.register(provider);
  
  // Register models
  const models = await provider.listModels();
  for (const model of models) {
    this.firewall.register(model);
  }
}
```

4. **Add credential support:**
```typescript
// EnvironmentCredentialStore
case "newprovider":
  return process.env.NEWPROVIDER_API_KEY;
```

---

## Current Limitations

1. **Single production provider** — Only OpenRouter implemented
2. **No credential rotation** — API keys set once at startup
3. **No rate limiting** — Provider-side limits not mapped
4. **No fallback** — If provider fails, turn fails (no secondary provider)

## Future Work

- Credential rotation and refresh
- Provider health monitoring with circuit breakers
- Multi-provider failover for resilience
- Cost tracking per-provider
- Rate limit awareness and backoff
