// VS Code extension entry point
const vscode = require("vscode");
const { CodeForgeServer } = require("@codeforge/server");

let server = null;

/**
 * Activate the extension. This is called when the extension is first loaded.
 */
function activate(context) {
  console.log("Activating CodeForge extension...");

  // Get global storage path for database
  const dbPath = context.globalStorageUri.fsPath;

  // Create the server instance using the same configuration as desktop
  server = new CodeForgeServer({
    port: 3210,
    dbPath,
  });

  // Start the server
  server.start().then(() => {
    console.log("CodeForge server started on port " + server.httpPort);
    vscode.window.showInformationMessage("CodeForge server started successfully");
  }).catch((error) => {
    console.error("Failed to start CodeForge server:", error);
    vscode.window.showErrorMessage(
      "Failed to start CodeForge server: " + (error instanceof Error ? error.message : String(error))
    );
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("codeforge.startSession", async () => {
      await startSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeforge.sendMessage", async () => {
      await sendMessage();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeforge.openWebview", async () => {
      await openWebview(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeforge.stopServer", async () => {
      stopServer();
    })
  );

  console.log("CodeForge extension activated");
}

/**
 * Deactivate the extension. Clean up resources.
 */
function deactivate() {
  console.log("Deactivating CodeForge extension...");

  if (server) {
    server.stop();
    server = null;
    console.log("CodeForge server stopped");
  }
}

/**
 * Start a new session via the server API.
 */
async function startSession() {
  if (!server) {
    vscode.window.showErrorMessage("CodeForge server is not running");
    return;
  }

  const sessionId = crypto.randomUUID();
  const userMessage = "Start a new session";

  try {
    const response = await fetch("http://localhost:" + server.httpPort + "/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: userMessage }),
    });

    if (response.ok) {
      const data = await response.json();
      vscode.window.showInformationMessage(
        "Session started: " + sessionId + "\nTurn ID: " + data.turnId
      );
    } else {
      const errorData = await response.json();
      vscode.window.showErrorMessage(
        "Failed to start session: " + (errorData.error || "Unknown error")
      );
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      "Failed to start session: " + (error instanceof Error ? error.message : String(error))
    );
  }
}

/**
 * Send a message to the current session via the server API.
 */
async function sendMessage() {
  if (!server) {
    vscode.window.showErrorMessage("CodeForge server is not running");
    return;
  }

  // Get the workspace folder
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  const workspacePath = workspaceFolders[0].uri.fsPath;

  // Set the workspace first
  try {
    const setWorkspaceResponse = await fetch("http://localhost:" + server.httpPort + "/api/workspace/set", {
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
      "Failed to set workspace: " + (error instanceof Error ? error.message : String(error))
    );
    return;
  }

  // Get message from user
  const message = await vscode.window.showInputBox({
    placeHolder: "Enter your message",
    prompt: "Enter the message to send to CodeForge",
  });

  if (!message) {
    return;
  }

  // Start a turn with the message
  const sessionId = "vscode-session";
  try {
    const response = await fetch("http://localhost:" + server.httpPort + "/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
    });

    if (response.ok) {
      const data = await response.json();
      vscode.window.showInformationMessage("Turn started: " + data.turnId);
    } else {
      const errorData = await response.json();
      vscode.window.showErrorMessage(
        "Failed to send message: " + (errorData.error || "Unknown error")
      );
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      "Failed to send message: " + (error instanceof Error ? error.message : String(error))
    );
  }
}

/**
 * Open the CodeForge webview/panel.
 */
async function openWebview(context) {
  const panel = vscode.window.createWebviewPanel("codeforge", "CodeForge", vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  // Get the webview HTML - use the built renderer
  const rendererPath = panel.webview.asWebviewUri(
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
        // Webview will be loaded from the renderer
        window.location.href = "${rendererPath.toString()}";
      </script>
    </body>
    </html>
  `;
}

/**
 * Stop the CodeForge server.
 */
function stopServer() {
  if (server) {
    server.stop();
    server = null;
    vscode.window.showInformationMessage("CodeForge server stopped");
  } else {
    vscode.window.showInformationMessage("CodeForge server is not running");
  }
}

module.exports = { activate, deactivate };
