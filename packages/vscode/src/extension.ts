// VS Code extension entry point
import * as vscode from "vscode";
import { CodeForgeServer } from "@codeforge/server";

let server: CodeForgeServer | null = null;

export function activate(context: vscode.ExtensionContext): void {
  vscode.window.showInformationMessage("Activating CodeForge extension...");

  const dbPath = context.globalStorageUri.fsPath;

  server = new CodeForgeServer({
    port: 3210,
    dbPath,
  });

  server.start().then(() => {
    const httpPort = server?.httpPort;
    if (httpPort) {
      vscode.window.showInformationMessage(`CodeForge server started on port ${httpPort}`);
    }
  }).catch((error: unknown) => {
    vscode.window.showErrorMessage(
      `Failed to start CodeForge server: ${error instanceof Error ? error.message : String(error)}`
    );
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("codeforge.startSession", startSession)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeforge.sendMessage", sendMessage)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeforge.openWebview", () => openWebview(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeforge.stopServer", stopServer)
  );
}

export function deactivate(): void {
  if (server) {
    server.stop();
    server = null;
  }
}

async function startSession(): Promise<void> {
  if (!server) {
    vscode.window.showErrorMessage("CodeForge server is not running");
    return;
  }

  const sessionId = crypto.randomUUID();

  try {
    const response = await fetch(`http://localhost:${server.httpPort}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: "Start a new session" }),
    });

    if (response.ok) {
      const data = await response.json() as { turnId?: string };
      vscode.window.showInformationMessage(
        `Session started: ${sessionId}\nTurn ID: ${data.turnId ?? "unknown"}`
      );
    } else {
      const errorData = await response.json() as { error?: string };
      vscode.window.showErrorMessage(
        `Failed to start session: ${errorData?.error ?? "Unknown error"}`
      );
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to start session: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function sendMessage(): Promise<void> {
  if (!server) {
    vscode.window.showErrorMessage("CodeForge server is not running");
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  const folder = workspaceFolders[0];
  if (!folder) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }
  const workspacePath = folder.uri.fsPath;

  try {
    const setWorkspaceResponse = await fetch(`http://localhost:${server.httpPort}/api/workspace/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: workspacePath }),
    });

    if (!setWorkspaceResponse.ok) {
      vscode.window.showErrorMessage("Failed to set workspace");
      return;
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to set workspace: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const message = await vscode.window.showInputBox({
    placeHolder: "Enter your message",
    prompt: "Enter the message to send to CodeForge",
  });

  if (!message) {
    return;
  }

  const sessionId = "vscode-session";
  try {
    const response = await fetch(`http://localhost:${server.httpPort}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
    });

    if (response.ok) {
      const data = await response.json() as { turnId?: string };
      vscode.window.showInformationMessage(`Turn started: ${data.turnId ?? "unknown"}`);
    } else {
      const errorData = await response.json() as { error?: string };
      vscode.window.showErrorMessage(
        `Failed to send message: ${errorData?.error ?? "Unknown error"}`
      );
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to send message: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function openWebview(context: vscode.ExtensionContext): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "codeforge",
    "CodeForge",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  const rendererUri = panel.webview.asWebviewUri(
    vscode.Uri.file(context.asAbsolutePath("./dist/renderer/index.html"))
  );

  panel.webview.html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CodeForge</title>
      <style>
        body { margin: 0; padding: 0; font-family: -apple-system, sans-serif; }
        #app { min-height: 100vh; }
      </style>
    </head>
    <body>
      <div id="app"></div>
      <script>
        window.location.href = "${rendererUri.toString()}";
      </script>
    </body>
    </html>
  `;
}

function stopServer(): void {
  if (server) {
    server.stop();
    server = null;
    vscode.window.showInformationMessage("CodeForge server stopped");
  } else {
    vscode.window.showInformationMessage("CodeForge server is not running");
  }
}
