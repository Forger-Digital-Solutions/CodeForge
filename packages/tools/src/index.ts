import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { type AgentPermissions, ERROR_CODES, formatUntrustedData } from "@codeforge/agent";
import { redactSecrets } from "@codeforge/secrets";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  requiredPermission: keyof AgentPermissions;
  readOnly: boolean;
  executionClass: "read" | "write" | "command" | "repo" | "checkpoint";
}

export interface ToolExecutionContext {
  workspacePath: string;
  permissions: AgentPermissions;
  role?: string;
  runId?: string;
  agentId?: string;
  signal?: AbortSignal;
  customExecutor?: (name: string, args: Record<string, unknown>) => Promise<string | undefined>;
}

export interface ToolExecutionRecord {
  toolExecutionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  readOnly: boolean;
  truncated: boolean;
}

export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
export const MAX_TOOL_OUTPUT_LINES = 500;

export function truncateToolOutput(text: string, maxBytes: number = MAX_TOOL_OUTPUT_BYTES, label: string = "output"): { output: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return { output: text, truncated: false };
  }
  const buf = Buffer.from(text, "utf-8");
  const sliced = buf.subarray(0, maxBytes).toString("utf-8");
  return {
    output: `${sliced}\n[TRUNCATED ${label.toUpperCase()}: exceeded ${maxBytes} bytes, showing first ${maxBytes}]`,
    truncated: true,
  };
}

export function realpathDeepestExisting(target: string): string {
  const absolute = path.resolve(target);
  let current = absolute;
  for (;;) {
    try {
      return fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      current = parent;
    }
  }
}

function escapesBoundary(relative: string): boolean {
  const normalized = process.platform === "win32" ? relative.toLowerCase() : relative;
  if (normalized === "") return false;
  if (path.isAbsolute(normalized)) return true;
  return normalized === ".." || normalized.startsWith(".." + path.sep) || normalized.startsWith("../");
}

export function resolveWithinWorkspace(
  workspaceRoot: string,
  requestedPath: string,
): { valid: boolean; resolvedPath?: string; error?: string } {
  if (!workspaceRoot) {
    return { valid: false, error: "No workspace path configured" };
  }
  if (!requestedPath || typeof requestedPath !== "string") {
    return { valid: false, error: "Path must be a non-empty string" };
  }

  // Windows UNC path rejection
  if (requestedPath.startsWith("\\\\") || requestedPath.startsWith("//")) {
    return { valid: false, error: `Path traversal denied (UNC paths prohibited): ${requestedPath}` };
  }

  const rootReal = realpathDeepestExisting(workspaceRoot);
  const lexical = path.resolve(rootReal, requestedPath);

  if (escapesBoundary(path.relative(rootReal, lexical))) {
    return { valid: false, error: `Path traversal denied (escapes workspace root): ${requestedPath}` };
  }

  const effective = realpathDeepestExisting(lexical);
  if (escapesBoundary(path.relative(rootReal, effective))) {
    return { valid: false, error: `Path traversal denied (symlink points outside workspace): ${requestedPath}` };
  }

  return { valid: true, resolvedPath: lexical };
}

function isSensitiveToolPath(targetPath: string): boolean {
  const base = path.basename(targetPath.replace(/\\/g, "/")).toLowerCase();
  return base === ".env" || base.startsWith(".env.") ||
    /^(?:credentials?|secrets?|tokens?)\.(?:json|ya?ml|toml|ini|txt)$/i.test(base) ||
    /^(?:id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i.test(base);
}

const SENSITIVE_EXACT_DENY = new Set<string>([
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "CODEFORGE_API_KEY",
  "HF_TOKEN",
  "HUGGINGFACE_API_KEY",
  "COHERE_API_KEY",
  "REPLICATE_API_TOKEN",
]);

const SENSITIVE_SUBSTRINGS = [
  "SECRET",
  "PASSWORD",
  "PRIVATE_KEY",
  "CREDENTIAL",
  "AUTH_TOKEN",
  "ACCESS_TOKEN",
  "REFRESH_TOKEN",
  "API_KEY",
  "TOKEN",
];

const SENSITIVE_PREFIXES = [
  "AWS_",
  "AZURE_",
  "GCP_",
  "GOOGLE_",
  "GOOGLE_CREDENTIALS",
  "CLOUDFLARE_",
  "OPENAI_",
  "ANTHROPIC_",
  "GROQ_",
  "OPENROUTER_",
  "OPENCODE_",
  "CODEFORGE_",
];

export function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SENSITIVE_EXACT_DENY.has(upper)) return true;
  for (const p of SENSITIVE_PREFIXES) {
    if (upper.startsWith(p)) return true;
  }
  for (const s of SENSITIVE_SUBSTRINGS) {
    if (upper.includes(s)) return true;
  }
  return false;
}

export function getSanitizedEnvForChild(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const runtimeAllowlist = new Set([
    "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE",
    "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "HOME", "SHELL",
    "TERM", "LANG", "LC_ALL", "TZ",
  ]);
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (isSensitiveEnvKey(k)) continue;
    if (!runtimeAllowlist.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  const inheritedPath = process.env.Path ?? process.env.PATH ?? "";
  const nodeDirectory = path.dirname(process.execPath);
  out.PATH = inheritedPath
    .split(path.delimiter)
    .filter(Boolean)
    .includes(nodeDirectory)
      ? inheritedPath
      : [nodeDirectory, inheritedPath].filter(Boolean).join(path.delimiter);
  return out;
}

export const BUILT_IN_TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  read_file: {
    name: "read_file",
    description: "Read the contents of a file in the workspace. Returns content and SHA-256 hash.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to file relative to workspace root" },
        startLine: { type: "number", description: "Optional 1-based start line" },
        endLine: { type: "number", description: "Optional 1-based end line" },
      },
      required: ["path"],
    },
    requiredPermission: "read",
    readOnly: true,
    executionClass: "read",
  },
  list_files: {
    name: "list_files",
    description: "List files and directories in the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to workspace root" },
        recursive: { type: "boolean", description: "Whether to list recursively" },
      },
      required: ["path"],
    },
    requiredPermission: "read",
    readOnly: true,
    executionClass: "read",
  },
  search_files: {
    name: "search_files",
    description: "Search workspace files for matching text or regex pattern.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or pattern to search for" },
        regex: { type: "boolean", description: "Treat query as regex" },
        caseSensitive: { type: "boolean", description: "Case sensitive match" },
        maxMatches: { type: "number", description: "Max matches to return" },
      },
      required: ["query"],
    },
    requiredPermission: "search",
    readOnly: true,
    executionClass: "read",
  },
  write_file: {
    name: "write_file",
    description: "Write content to a file in the workspace. Overwrites existing file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to file relative to workspace root" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
    requiredPermission: "write",
    readOnly: false,
    executionClass: "write",
  },
  edit_file: {
    name: "edit_file",
    description: "Surgically edit a file by replacing oldText with newText. Checks hash or exact occurrences.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to file relative to workspace root" },
        oldText: { type: "string", description: "Exact text segment to replace" },
        newText: { type: "string", description: "New replacement text" },
        expectedOccurrences: { type: "number", description: "Expected occurrence count (default 1)" },
        expectedHash: { type: "string", description: "Expected SHA-256 hash of file before edit" },
      },
      required: ["path", "oldText", "newText"],
    },
    requiredPermission: "write",
    readOnly: false,
    executionClass: "write",
  },
  run_command: {
    name: "run_command",
    description: "Execute a shell command in the workspace directory with sanitized environment.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute" },
        cwd: { type: "string", description: "Optional working directory relative to workspace root" },
      },
      required: ["command"],
    },
    requiredPermission: "executeCommand",
    readOnly: false,
    executionClass: "command",
  },
  repo_search: {
    name: "repo_search",
    description: "Search indexed repository intelligence for relevant files, symbols, and tests.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or identifier" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["query"],
    },
    requiredPermission: "search",
    readOnly: true,
    executionClass: "repo",
  },
  repo_symbol: {
    name: "repo_symbol",
    description: "Search structurally indexed symbols and definitions in repository intelligence.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol or identifier name" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["query"],
    },
    requiredPermission: "search",
    readOnly: true,
    executionClass: "repo",
  },
  repo_references: {
    name: "repo_references",
    description: "Find definitions and classified references for a symbol.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["query"],
    },
    requiredPermission: "search",
    readOnly: true,
    executionClass: "repo",
  },
  repo_dependencies: {
    name: "repo_dependencies",
    description: "Find imports and package dependencies of a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["path"],
    },
    requiredPermission: "read",
    readOnly: true,
    executionClass: "repo",
  },
  repo_dependents: {
    name: "repo_dependents",
    description: "Find indexed files that depend on a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["path"],
    },
    requiredPermission: "read",
    readOnly: true,
    executionClass: "repo",
  },
  repo_tests: {
    name: "repo_tests",
    description: "Find tests related to an implementation file with confidence reasons.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["path"],
    },
    requiredPermission: "read",
    readOnly: true,
    executionClass: "repo",
  },
  repo_context: {
    name: "repo_context",
    description: "Build a fresh, deduplicated context pack within a token budget.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Task query" },
        contextWindow: { type: "number", description: "Context window in tokens" },
      },
      required: ["query"],
    },
    requiredPermission: "read",
    readOnly: true,
    executionClass: "repo",
  },
  repo_index_status: {
    name: "repo_index_status",
    description: "Return repository intelligence index status and health.",
    parameters: {
      type: "object",
      properties: {},
    },
    requiredPermission: "read",
    readOnly: true,
    executionClass: "repo",
  },
  create_checkpoint: {
    name: "create_checkpoint",
    description: "Create a durable git checkpoint for recovery before significant modifications.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Checkpoint label" },
      },
      required: ["label"],
    },
    requiredPermission: "read",
    readOnly: false,
    executionClass: "checkpoint",
  },
};

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor() {
    for (const def of Object.values(BUILT_IN_TOOL_DEFINITIONS)) {
      this.tools.set(def.name, def);
    }
  }

  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  all(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getForRole(role: string, permissions: AgentPermissions): ToolDefinition[] {
    const isReadOnlyRole = role === "explorer" || role === "reviewer" || role === "planner" || role === "mission-planner" || role === "replanner";
    return Array.from(this.tools.values()).filter((tool) => {
      if (isReadOnlyRole && !tool.readOnly) return false;
      const permKey = tool.requiredPermission;
      if (permKey && !permissions[permKey]) return false;
      return true;
    });
  }
}

export class ToolBroker {
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry = new ToolRegistry()) {
    this.registry = registry;
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  async executeTool(
    call: { name: string; arguments: unknown },
    context: ToolExecutionContext,
  ): Promise<ToolExecutionRecord> {
    const startTime = Date.now();
    const toolExecutionId = `exec-${crypto.randomUUID()}`;
    const { name, arguments: rawArgs } = call;

    // 1. Tool Lookup
    const toolDef = this.registry.get(name);
    if (!toolDef) {
      const errMsg = `Error: [${ERROR_CODES.TOOL_UNKNOWN}] Tool "${name}" is not recognized in the trusted tool registry.`;
      return {
        toolExecutionId,
        toolName: name,
        arguments: typeof rawArgs === "object" && rawArgs ? (rawArgs as Record<string, unknown>) : {},
        success: false,
        output: errMsg,
        error: ERROR_CODES.TOOL_UNKNOWN,
        durationMs: Date.now() - startTime,
        readOnly: false,
        truncated: false,
      };
    }

    // 2. Argument validation
    let args: Record<string, unknown>;
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        const errMsg = `Error: [${ERROR_CODES.TOOL_ARGUMENT_INVALID}] Invalid JSON arguments for tool "${name}".`;
        return {
          toolExecutionId,
          toolName: name,
          arguments: {},
          success: false,
          output: errMsg,
          error: ERROR_CODES.TOOL_ARGUMENT_INVALID,
          durationMs: Date.now() - startTime,
          readOnly: toolDef.readOnly,
          truncated: false,
        };
      }
    } else if (typeof rawArgs === "object" && rawArgs !== null) {
      args = rawArgs as Record<string, unknown>;
    } else {
      args = {};
    }

    // Validate required parameters
    if (toolDef.parameters.required) {
      for (const req of toolDef.parameters.required) {
        if (args[req] === undefined || args[req] === null || (typeof args[req] === "string" && (args[req] as string).trim() === "")) {
          const errMsg = `Error: [${ERROR_CODES.TOOL_ARGUMENT_INVALID}] Missing required argument "${req}" for tool "${name}".`;
          return {
            toolExecutionId,
            toolName: name,
            arguments: args,
            success: false,
            output: errMsg,
            error: ERROR_CODES.TOOL_ARGUMENT_INVALID,
            durationMs: Date.now() - startTime,
            readOnly: toolDef.readOnly,
            truncated: false,
          };
        }
      }
    }

    // 3. Permission enforcement (Role & Effective Permissions)
    const isReadOnlyRole = context.role === "explorer" || context.role === "reviewer" || context.role === "planner";
    if (isReadOnlyRole && !toolDef.readOnly) {
      const errMsg = `Error: [${ERROR_CODES.TOOL_PERMISSION_DENIED}] Role "${context.role}" is strictly read-only and cannot execute mutating tool "${name}".`;
      return {
        toolExecutionId,
        toolName: name,
        arguments: args,
        success: false,
        output: errMsg,
        error: ERROR_CODES.TOOL_PERMISSION_DENIED,
        durationMs: Date.now() - startTime,
        readOnly: toolDef.readOnly,
        truncated: false,
      };
    }

    const requiredPerm = toolDef.requiredPermission;
    if (requiredPerm && !context.permissions[requiredPerm]) {
      const errMsg = `Error: [${ERROR_CODES.TOOL_PERMISSION_DENIED}] Agent does not possess required permission "${requiredPerm}" for tool "${name}".`;
      return {
        toolExecutionId,
        toolName: name,
        arguments: args,
        success: false,
        output: errMsg,
        error: ERROR_CODES.TOOL_PERMISSION_DENIED,
        durationMs: Date.now() - startTime,
        readOnly: toolDef.readOnly,
        truncated: false,
      };
    }

    if (["read_file", "write_file", "edit_file"].includes(name) && typeof args.path === "string" && isSensitiveToolPath(args.path)) {
      const errMsg = `Error: [${ERROR_CODES.TOOL_SENSITIVE_PATH_DENIED}] Sensitive path access is not available to agents.`;
      return {
        toolExecutionId,
        toolName: name,
        arguments: args,
        success: false,
        output: errMsg,
        error: ERROR_CODES.TOOL_SENSITIVE_PATH_DENIED,
        durationMs: Date.now() - startTime,
        readOnly: toolDef.readOnly,
        truncated: false,
      };
    }

    // 4. Custom Executor Delegation (if provided, e.g. for repo-intelligence tools or mocks)
    if (context.customExecutor) {
      try {
        const rawOutput = await context.customExecutor(name, args);
        if (rawOutput !== undefined) {
          const redacted = redactSecrets(rawOutput);
          const { output: boundedOutput, truncated } = truncateToolOutput(redacted, MAX_TOOL_OUTPUT_BYTES, name);
          return {
            toolExecutionId,
            toolName: name,
            arguments: args,
            success: !boundedOutput.startsWith("Error:"),
            output: boundedOutput,
            durationMs: Date.now() - startTime,
            readOnly: toolDef.readOnly,
            truncated,
          };
        }
      } catch (e) {
        const rawError = e instanceof Error ? e.message : String(e);
        const redacted = redactSecrets(rawError);
        return {
          toolExecutionId,
          toolName: name,
          arguments: args,
          success: false,
          output: `Error: ${redacted}`,
          error: redacted,
          durationMs: Date.now() - startTime,
          readOnly: toolDef.readOnly,
          truncated: false,
        };
      }
    }

    // 5. Default Built-in Tool Implementations with Path Confinement & Sandbox Controls
    try {
      let rawResult: string;

      switch (name) {
        case "read_file": {
          const targetPath = String(args.path);
          const confinement = resolveWithinWorkspace(context.workspacePath, targetPath);
          if (!confinement.valid || !confinement.resolvedPath) {
            throw new Error(`[${ERROR_CODES.TOOL_WORKSPACE_ESCAPE}] ${confinement.error}`);
          }
          if (!fs.existsSync(confinement.resolvedPath)) {
            throw new Error(`File not found: ${targetPath}`);
          }
          const stats = fs.statSync(confinement.resolvedPath);
          if (!stats.isFile()) {
            throw new Error(`Not a file: ${targetPath}`);
          }
          const raw = fs.readFileSync(confinement.resolvedPath, "utf-8");
          if (raw.includes("\0")) {
            rawResult = `[Binary file not displayed: ${targetPath}]`;
          } else {
            const hash = crypto.createHash("sha256").update(raw).digest("hex");
            const lines = raw.split("\n");
            let start = 1;
            let end = lines.length;
            if (typeof args.startLine === "number" && args.startLine > 0) start = Math.floor(args.startLine);
            if (typeof args.endLine === "number" && args.endLine >= start) end = Math.min(lines.length, Math.floor(args.endLine));
            const slice = lines.slice(start - 1, end).join("\n");
            rawResult = `${slice}\n[hash:${hash}]`;
          }
          break;
        }

        case "list_files": {
          const targetPath = String(args.path || ".");
          const confinement = resolveWithinWorkspace(context.workspacePath, targetPath);
          if (!confinement.valid || !confinement.resolvedPath) {
            throw new Error(`[${ERROR_CODES.TOOL_WORKSPACE_ESCAPE}] ${confinement.error}`);
          }
          if (!fs.existsSync(confinement.resolvedPath)) {
            throw new Error(`Directory not found: ${targetPath}`);
          }
          const stats = fs.statSync(confinement.resolvedPath);
          if (!stats.isDirectory()) {
            throw new Error(`Not a directory: ${targetPath}`);
          }
          const recursive = Boolean(args.recursive);
          const entries: string[] = [];
          const collect = (dir: string, base: string) => {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
              if (item.name.startsWith(".") && item.name !== ".git") continue;
              const rel = path.join(base, item.name);
              if (item.isDirectory()) {
                entries.push(`${rel}/`);
                if (recursive) collect(path.join(dir, item.name), rel);
              } else {
                entries.push(rel);
              }
            }
          };
          collect(confinement.resolvedPath, "");
          rawResult = entries.slice(0, MAX_TOOL_OUTPUT_LINES).join("\n");
          break;
        }

        case "search_files": {
          const query = String(args.query);
          const isRegex = Boolean(args.regex);
          const caseSensitive = Boolean(args.caseSensitive);
          const maxMatches = typeof args.maxMatches === "number" ? Math.min(args.maxMatches, 200) : 50;
          const root = context.workspacePath;
          const matches: string[] = [];
          const reg = isRegex
            ? new RegExp(query, caseSensitive ? "g" : "gi")
            : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");

          const searchDir = (dir: string) => {
            if (matches.length >= maxMatches) return;
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
              if (matches.length >= maxMatches) break;
              if (item.name.startsWith(".") || item.name === "node_modules" || item.name === "dist") continue;
              const full = path.join(dir, item.name);
              if (item.isDirectory()) {
                searchDir(full);
              } else if (item.isFile()) {
                try {
                  const content = fs.readFileSync(full, "utf-8");
                  if (content.includes("\0")) continue;
                  const lines = content.split("\n");
                  for (let i = 0; i < lines.length; i++) {
                    if (reg.test(lines[i]!)) {
                      const rel = path.relative(root, full);
                      matches.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
                      if (matches.length >= maxMatches) break;
                    }
                  }
                } catch {}
              }
            }
          };
          searchDir(root);
          rawResult = matches.length > 0 ? matches.join("\n") : "No matches found.";
          break;
        }

        case "write_file": {
          const targetPath = String(args.path);
          const confinement = resolveWithinWorkspace(context.workspacePath, targetPath);
          if (!confinement.valid || !confinement.resolvedPath) {
            throw new Error(`[${ERROR_CODES.TOOL_WORKSPACE_ESCAPE}] ${confinement.error}`);
          }
          const content = String(args.content ?? "");
          const dir = path.dirname(confinement.resolvedPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(confinement.resolvedPath, content, "utf-8");
          rawResult = `Successfully wrote ${content.length} characters to ${targetPath}`;
          break;
        }

        case "edit_file": {
          const targetPath = String(args.path);
          const confinement = resolveWithinWorkspace(context.workspacePath, targetPath);
          if (!confinement.valid || !confinement.resolvedPath) {
            throw new Error(`[${ERROR_CODES.TOOL_WORKSPACE_ESCAPE}] ${confinement.error}`);
          }
          if (!fs.existsSync(confinement.resolvedPath)) {
            throw new Error(`File not found: ${targetPath}`);
          }
          const raw = fs.readFileSync(confinement.resolvedPath, "utf-8");
          const oldText = String(args.oldText);
          const newText = String(args.newText);
          const expectedOccurrences = typeof args.expectedOccurrences === "number" ? args.expectedOccurrences : 1;
          const expectedHash = typeof args.expectedHash === "string" ? args.expectedHash : undefined;

          if (expectedHash) {
            const currentHash = crypto.createHash("sha256").update(raw).digest("hex");
            if (currentHash !== expectedHash) {
              throw new Error(`[${ERROR_CODES.CONTEXT_EVIDENCE_STALE}] Stale edit rejected: file hash mismatch (expected ${expectedHash.slice(0, 8)}, found ${currentHash.slice(0, 8)})`);
            }
          }

          const count = raw.split(oldText).length - 1;
          if (count === 0) {
            throw new Error(`oldText not found in ${targetPath}`);
          }
          if (count !== expectedOccurrences) {
            throw new Error(`Expected ${expectedOccurrences} occurrence(s) of oldText but found ${count}`);
          }

          const replaced = raw.replace(oldText, newText);
          fs.writeFileSync(confinement.resolvedPath, replaced, "utf-8");
          const afterHash = crypto.createHash("sha256").update(replaced).digest("hex");
          rawResult = `Successfully edited ${targetPath} (after hash: ${afterHash.slice(0, 8)})`;
          break;
        }

        case "run_command": {
          const cmd = String(args.command);
          // `cmd.exe` can be launched with a constrained environment where
          // command lookup is unreliable even when the Node runtime is on
          // PATH. Resolve the runtime's own executable explicitly for the
          // common `node …` form without granting access to host secrets.
          const executionCommand = cmd.replace(
            /(^|[&|;]\s*)node(?=\s|$)/g,
            `$1"${process.execPath}"`,
          );
          const nodeEval = /^node\s+-e\s+(?:(["'])([\s\S]*)\1|([\s\S]+))$/.exec(cmd.trim());
          const targetCwd = args.cwd ? String(args.cwd) : ".";
          const confinement = resolveWithinWorkspace(context.workspacePath, targetCwd);
          if (!confinement.valid || !confinement.resolvedPath) {
            throw new Error(`[${ERROR_CODES.TOOL_WORKSPACE_ESCAPE}] ${confinement.error}`);
          }

          rawResult = await new Promise<string>((resolve, reject) => {
            const sanitizedEnv = getSanitizedEnvForChild();
            const isWin = process.platform === "win32";
            const shellExecutable = nodeEval ? process.execPath : (isWin ? "cmd.exe" : "/bin/sh");
            const shellArgs = nodeEval
              ? ["-e", nodeEval[2] ?? nodeEval[3] ?? ""]
              : (isWin ? ["/d", "/c", executionCommand] : ["-c", executionCommand]);

            const proc = spawn(shellExecutable, shellArgs, {
              cwd: confinement.resolvedPath,
              env: sanitizedEnv,
              windowsHide: true,
            });

            let stdout = "";
            let stderr = "";
            let timer: NodeJS.Timeout | undefined;

            const cleanup = () => {
              if (timer) clearTimeout(timer);
            };

            timer = setTimeout(() => {
              cleanup();
              try { proc.kill("SIGKILL"); } catch {}
              reject(new Error(`[${ERROR_CODES.TOOL_TIMEOUT}] Command timed out after 60 seconds: ${cmd}`));
            }, 60_000);

            if (context.signal) {
              context.signal.addEventListener("abort", () => {
                cleanup();
                try { proc.kill("SIGKILL"); } catch {}
                reject(new Error(`[${ERROR_CODES.AGENT_CANCELLED}] Command execution cancelled`));
              }, { once: true });
            }

            proc.stdout.on("data", (d) => { stdout += d.toString(); });
            proc.stderr.on("data", (d) => { stderr += d.toString(); });

            proc.on("close", (code) => {
              cleanup();
              const combined = [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
              resolve(`Exit code: ${code ?? 0}\n${combined}`);
            });

            proc.on("error", (err) => {
              cleanup();
              reject(err);
            });
          });
          break;
        }

        default:
          rawResult = `Tool "${name}" executed successfully.`;
      }

      const redacted = redactSecrets(rawResult);
      const { output: boundedOutput, truncated } = truncateToolOutput(redacted, MAX_TOOL_OUTPUT_BYTES, name);

      return {
        toolExecutionId,
        toolName: name,
        arguments: args,
        success: true,
        output: boundedOutput,
        durationMs: Date.now() - startTime,
        readOnly: toolDef.readOnly,
        truncated,
      };
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const redacted = redactSecrets(rawMsg);
      const isEscape = redacted.includes(ERROR_CODES.TOOL_WORKSPACE_ESCAPE);
      const errorCode = isEscape ? ERROR_CODES.TOOL_PATH_ESCAPE : ERROR_CODES.TOOL_EXECUTION_FAILED;

      return {
        toolExecutionId,
        toolName: name,
        arguments: args,
        success: false,
        output: `Error: ${redacted}`,
        error: errorCode,
        durationMs: Date.now() - startTime,
        readOnly: toolDef.readOnly,
        truncated: false,
      };
    }
  }
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}

export function createToolBroker(registry?: ToolRegistry): ToolBroker {
  return new ToolBroker(registry);
}
