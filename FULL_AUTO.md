# CodeForge Full Autonomous Execution

## Overview

CodeForge executes engineering tasks autonomously: planning, implementation, testing, and review. This document describes the autonomous workflow from task submission to completion.

---

## Task Lifecycle

### 1. Task Submission

```typescript
// User sends message via API
POST /api/send
{
  "sessionId": "session-123",
  "message": "Implement user authentication with JWT tokens"
}
```

### 2. Turn Creation

```typescript
// Server creates turn
const turnId = await runtime.startTurn(userMessage);

// Turn state initialized
{
  turnId: "turn-abc",
  sessionId: "session-123",
  status: "running",
  userMessage: "Implement user authentication...",
  startedAt: Date
}
```

### 3. Model Selection

```typescript
// Router resolves model
const model = router.resolveSelection(selection);

// ForgeZero validates
const result = firewall.verify(model.providerId, model.modelId);
if (!result.ok) {
  throw new Error(`Model rejected: ${result.error.message}`);
}
```

### 4. Prompt Assembly

```typescript
const systemPrompt = `
You are CodeForge, an autonomous software engineering agent.
You help users with coding tasks by reading files, writing code, and executing commands.
Always think step by step and explain your reasoning.

The workspace is located at: ${workspacePath}
`;

const request: ChatRequest = {
  model: model.modelId,
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ],
  tools: getAvailableTools(),
  toolChoice: "auto",
};
```

### 5. Tool Execution Loop

```typescript
async function runAgentLoop(request: ChatRequest, iteration: number): Promise<void> {
  if (iteration >= maxIterations) {
    adapter.emitTextDelta("\n[Maximum iterations reached. Stopping.]");
    return;
  }
  
  // Stream from provider
  for await (const event of provider.streamChat(request, signal)) {
    switch (event.type) {
      case "text_delta":
        adapter.emitTextDelta(event.delta);
        currentText += event.delta;
        break;
        
      case "tool_call_completed":
        toolCalls.push(event);
        break;
        
      case "finish":
        finishReason = event.finishReason;
        break;
    }
  }
  
  // Execute tools if any
  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      const result = await executeTool(tc);
      messageHistory.push({ role: "tool", content: result, toolCallId: tc.id });
    }
    
    // Recursive call with updated history
    await runAgentLoop({ ...request, messages: messageHistory }, iteration + 1);
  }
}
```

### 6. Tool Definitions

```typescript
const tools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
];
```

### 7. Tool Execution

```typescript
async function executeTool(toolCall: ToolCall): Promise<string> {
  const args = JSON.parse(toolCall.arguments);
  
  // Verify workspace boundary
  if (!isWithinWorkspace(args.path)) {
    return `Error: Path outside workspace: ${args.path}`;
  }
  
  // ForgeZero verification (creative work check)
  const verification = firewall.verify(providerId, modelId);
  if (!verification.ok) {
    return `Blocked by ForgeZero: ${verification.error.message}`;
  }
  
  switch (toolCall.name) {
    case "read_file":
      return fs.readFileSync(args.path, "utf-8");
      
    case "write_file":
      fs.writeFileSync(args.path, args.content, "utf-8");
      return `Wrote ${args.content.length} characters to ${args.path}`;
      
    case "run_command":
      return executeCommand(args.command, args.cwd);
      
    default:
      return `Unknown tool: ${toolCall.name}`;
  }
}
```

### 8. Turn Completion

```typescript
// After agent loop finishes
state.status = "completed";
state.completedAt = new Date();

adapter.emitTurnCompleted(turnId, "Task completed successfully");
adapter.emitStatusChanged("running", "completed");
```

---

## Events Emitted During Execution

### Status Events

```typescript
{ type: "status.changed", payload: { from: "idle", to: "running" } }
{ type: "status.changed", payload: { from: "running", to: "completed" } }
```

### Turn Events

```typescript
{ type: "turn.started", payload: { turnId, userMessage } }
{ type: "turn.completed", payload: { turnId, result } }
{ type: "turn.failed", payload: { turnId, error } }
```

### Agent Events

```typescript
{ type: "agent.started", payload: { agentId, role, taskId } }
{ type: "agent.completed", payload: { agentId, taskId } }
```

### Tool Events

```typescript
{ type: "tool.call_started", payload: { toolCallId, toolName } }
{ type: "tool.call_completed", payload: { toolCallId, toolName, arguments, result } }
```

### File Events

```typescript
{ type: "file.read", payload: { fileCallId, path, lines } }
{ type: "file.change_proposed", payload: { changeId, path, changeType, diff } }
{ type: "file.change_applied", payload: { changeId, path } }
```

---

## Control Flow Operations

### Pause

```typescript
// POST /api/sessions/:sessionId/turns/:turnId/pause
runtime.pauseTurn(turnId);

// Validates: status must be "running"
// Actions:
// 1. Abort active provider stream
// 2. Set status to "paused"
// 3. Persist turn state
// 4. Emit turn.paused event
```

### Resume

```typescript
// POST /api/sessions/:sessionId/turns/:turnId/resume
runtime.resumeTurn(turnId);

// Validates: status must be "paused"
// Actions:
// 1. Set status to "running"
// 2. Create new AbortController
// 3. Restart executeTurn with saved message
// 4. Emit turn.resumed event
```

### Cancel

```typescript
// POST /api/sessions/:sessionId/turns/:turnId/cancel?reason=...
runtime.cancelTurn(turnId, reason);

// Actions:
// 1. Abort active stream
// 2. Set status to "cancelled"
// 3. Persist turn state
// 4. Emit turn.cancelled event
```

---

## Error Handling

### Provider Errors

```typescript
// Caught in executeTurn()
catch (error) {
  state.status = "failed";
  state.error = error.message;
  
  adapter.emitTurnFailed(turnId, error.message);
  adapter.emitStatusChanged("running", "failed");
}
```

### Tool Errors

```typescript
// Returned as tool result
catch (error) {
  return `Error: ${error.message}`;
}

// Agent decides whether to retry or abort
```

### Boundary Violations

```typescript
// Blocked before execution
function validatePath(path: string): { valid: boolean; error?: string } {
  const resolution = resolveWithinWorkspace(workspacePath, path);
  if (!resolution.valid) {
    return { valid: false, error: resolution.error };
  }
  return { valid: true };
}
```

---

## Demo Mode Execution

When `demoMode: true`, execution follows a different path:

```typescript
// AgentRuntime.startTurn()
if (this.demoMode) {
  // Skip executeTurn entirely
  // Turn stays in "running" state
  return turnId;
}

// Server runs demo simulation separately
runDemoRuntime({ sessionId, turnId, emit: (event) => { ... } });
```

Demo runtime emits pre-scripted events for UI testing without real inference.

---

## Testing

### Integration Tests

```typescript
// packages/integration-tests/test/pause-resume-cancel.test.ts
it("should complete a full run-pause-resume-cancel cycle", async () => {
  const { ok: startOk, turnId } = await sendMessage(port, sessionId, message);
  expect(startOk).toBe(true);
  
  await pause(1000);
  
  const { ok: pauseOk } = await pauseTurn(port, sessionId, turnId);
  expect(pauseOk).toBe(true);
  
  await pause(500);
  
  const { ok: resumeOk } = await resumeTurn(port, sessionId, turnId);
  expect(resumeOk).toBe(true);
  
  await pause(500);
  
  const { ok: cancelOk } = await cancelTurn(port, sessionId, turnId);
  expect(cancelOk).toBe(true);
});
```

---

## Current Limitations

1. **No subagent delegation** — Single agent handles entire task
2. **No plan visualization** — Plans created but not surfaced in UI
3. **No checkpoint rollback** — Git checkpoints created but not used for recovery
4. **No approval queue** — Approvals stored but queue not fully implemented
5. **No question resolution UI** — Questions blocked but no UI to answer

## Future Work

- Multi-agent task decomposition
- Plan step-by-step approval
- Automatic rollback on failure
- Approval workflow UI
- Question resolution panel
