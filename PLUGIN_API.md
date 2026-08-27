# CodeForge Plugin API

## Overview

The plugin system (`@codeforge/plugins`) provides extensibility for CodeForge. Plugins can add tools, register providers, hook into events, and extend the agent's capabilities.

---

## Plugin Interface

```typescript
interface CodeForgePlugin {
  // Metadata
  id: string;
  name: string;
  version: string;
  description?: string;
  
  // Lifecycle
  activate(context: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
  
  // Optional contributions
  tools?: ToolContribution[];
  providers?: ProviderContribution[];
  commands?: CommandContribution[];
  eventHandlers?: EventHandlerContribution[];
}
```

---

## Plugin Context

```typescript
interface PluginContext {
  // Core services
  eventStore: EventStore;
  persistence: SessionPersistence;
  firewall: ForgeZero;
  
  // Registration methods
  registerTool(tool: Tool): void;
  registerProvider(adapter: ProviderAdapter): void;
  registerCommand(command: Command): void;
  
  // Events
  onEvent(handler: (event: WorkspaceEvent) => void): void;
  
  // Configuration
  getConfiguration(key: string): unknown;
  getWorkspacePath(): string | undefined;
}
```

---

## Plugin Registry

```typescript
class PluginRegistry {
  private plugins: Map<string, CodeForgePlugin> = new Map();
  private context: PluginContext;
  
  async load(plugin: CodeForgePlugin): Promise<void> {
    await plugin.activate(this.context);
    this.plugins.set(plugin.id, plugin);
  }
  
  async unload(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (plugin?.deactivate) {
      await plugin.deactivate();
    }
    this.plugins.delete(pluginId);
  }
  
  getAllTools(): Tool[] {
    return Array.from(this.plugins.values())
      .flatMap(p => p.tools ?? []);
  }
  
  getAllProviders(): ProviderAdapter[] {
    return Array.from(this.plugins.values())
      .flatMap(p => p.providers ?? []);
  }
}
```

---

## Plugin Types

### Tool Plugins

Add new capabilities to the agent:

```typescript
const databasePlugin: CodeForgePlugin = {
  id: "database-query",
  name: "Database Query",
  version: "1.0.0",
  
  tools: [{
    type: "function",
    function: {
      name: "query_database",
      description: "Execute a SQL query against the configured database",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      },
    },
  }],
  
  async activate(context: PluginContext) {
    const dbPath = context.getConfiguration("database.path");
    // Configure database connection
  }
};
```

### Provider Plugins

Add new LLM backends:

```typescript
const anthropicPlugin: CodeForgePlugin = {
  id: "anthropic-provider",
  name: "Anthropic Provider",
  version: "1.0.0",
  
  providers: [new AnthropicAdapter(process.env.ANTHROPIC_API_KEY)],
  
  async activate(context: PluginContext) {
    const models = await this.providers[0].listModels();
    for (const model of models) {
      context.firewall.register(model);
    }
  }
};
```

### Command Plugins

Add CLI commands:

```typescript
const scaffoldPlugin: CodeForgePlugin = {
  id: "scaffold-commands",
  name: "Scaffold Commands",
  version: "1.0.0",
  
  commands: [{
    id: "scaffold.component",
    title: "Scaffold Component",
    handler: async (args) => {
      // Create component from template
    }
  }],
};
```

### Event Handler Plugins

React to workspace events:

```typescript
const notificationPlugin: CodeForgePlugin = {
  id: "desktop-notifications",
  name: "Desktop Notifications",
  version: "1.0.0",
  
  eventHandlers: [{
    events: ["turn.completed", "turn.failed"],
    handler: (event) => {
      // Show desktop notification
      showNotification(`Turn ${event.payload.turnId}: ${event.type}`);
    }
  }]
};
```

---

## Plugin Discovery

### Local Plugins

```typescript
// packages/plugins/src/loader.ts
async function loadLocalPlugins(pluginDir: string): Promise<CodeForgePlugin[]> {
  const plugins: CodeForgePlugin[] = [];
  
  for (const file of fs.readdirSync(pluginDir)) {
    if (file.endsWith(".plugin.js")) {
      const module = await import(path.join(pluginDir, file));
      plugins.push(module.default);
    }
  }
  
  return plugins;
}
```

### npm Packages

```typescript
async function loadNpmPlugin(packageName: string): Promise<CodeForgePlugin> {
  const module = await import(packageName);
  return module.default;
}
```

---

## Configuration

### Plugin Settings

Plugins access configuration through the context:

```typescript
// In plugin.activate()
const setting = context.getConfiguration("plugins.my-plugin.apiKey");
```

### Configuration Schema

```json
{
  "plugins": {
    "my-plugin": {
      "apiKey": "secret-key",
      "enabled": true
    }
  }
}
```

---

## Security

### Capability Restrictions

```typescript
interface PluginManifest {
  permissions?: {
    fs?: ("read" | "write")[];
    network?: boolean;
    process?: boolean;
  };
}
```

### Sandboxing

```typescript
class PluginSandbox {
  constructor(plugin: CodeForgePlugin, permissions: PluginPermissions) {}
  
  registerTool(tool: Tool): void {
    if (!this.canExecute("fs:write")) {
      throw new Error("Plugin lacks fs:write permission");
    }
    // Register with stripped privileges
  }
}
```

---

## Example: Custom Tool Plugin

```typescript
// my-scaffold-plugin.ts
import type { CodeForgePlugin, PluginContext } from "@codeforge/plugins";

interface ScaffoldTemplate {
  name: string;
  content: string;
}

const templates: ScaffoldTemplate[] = [
  { name: "react-component", content: "..." },
  { name: "api-route", content: "..." },
];

const ScaffoldPlugin: CodeForgePlugin = {
  id: "scaffold-plugin",
  name: "Scaffold Templates",
  version: "1.0.0",
  
  tools: [{
    type: "function",
    function: {
      name: "scaffold_from_template",
      description: "Create a file from a scaffold template",
      parameters: {
        type: "object",
        properties: {
          template: { 
            type: "string", 
            enum: templates.map(t => t.name) 
          },
          outputPath: { type: "string" },
          variables: { type: "object" },
        },
        required: ["template", "outputPath"],
      },
    },
  }],
  
  async activate(context: PluginContext) {
    this.context = context;
  },
  
  async executeTool(name, args) {
    if (name === "scaffold_from_template") {
      const template = templates.find(t => t.name === args.template);
      if (!template) {
        return `Error: Template '${args.template}' not found`;
      }
      
      const content = this.interpolate(template.content, args.variables ?? {});
      const valid = this.validatePath(args.outputPath);
      
      if (!valid.ok) {
        return `Error: ${valid.error}`;
      }
      
      fs.writeFileSync(args.outputPath, content);
      return `Created ${args.outputPath} from template ${args.template}`;
    }
  }
};

export default ScaffoldPlugin;
```

---

## Current Status

### Implemented

- `PluginRegistry` class defined
- `CodeForgePlugin` interface defined
- `PluginContext` interface defined
- Basic activation/deactivation

### Not Implemented

1. **Plugin loading** — No automatic discovery
2. **Plugin sandboxing** — No capability restrictions
3. **Plugin configuration UI** — No settings panel
4. **Hot reloading** — Plugins require restart
5. **Plugin marketplace** — No distribution mechanism

---

## Testing Plugins

```typescript
// packages/plugins/test/plugin.test.ts
describe("PluginRegistry", () => {
  it("loads and activates plugin", async () => {
    const registry = new PluginRegistry(context);
    
    await registry.load({
      id: "test",
      name: "Test Plugin",
      version: "1.0",
      activate: (ctx) => {
        ctx.registerTool({ /* tool def */ });
      }
    });
    
    const tools = registry.getAllTools();
    expect(tools).toHaveLength(1);
  });
});
```

---

## Future Work

1. **Plugin marketplace** — Discover and install plugins
2. **Hot reloading** — Add/remove plugins without restart
3. **Configuration UI** — Plugin settings in desktop app
4. **Sandboxing** — Capability-based security model
5. **Plugin API versioning** — Backward compatibility guarantees
