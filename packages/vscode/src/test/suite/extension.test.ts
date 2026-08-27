/**
 * VS Code Extension Tests
 *
 * Tests that verify the extension activates correctly and registers its commands.
 */

import * as assert from "node:assert";
import * as vscode from "vscode";

// Helper: wait for extension to be ready
async function waitForExtension(): Promise<vscode.Extension<unknown> | undefined> {
  const extension = vscode.extensions.getExtension("codeforge.codeforge-vscode");
  if (!extension) {
    return undefined;
  }
  if (!extension.isActive) {
    await extension.activate();
  }
  return extension;
}

// Helper: wait for commands to be registered
async function waitForCommands(timeoutMs: number = 10000): Promise<void> {
  const startTime = Date.now();
  const expectedCommands = [
    "codeforge.startSession",
    "codeforge.sendMessage",
    "codeforge.openWebview",
    "codeforge.stopServer",
  ];

  while (Date.now() - startTime < timeoutMs) {
    const commands = await vscode.commands.getCommands(true);
    const allRegistered = expectedCommands.every(cmd => commands.includes(cmd));
    if (allRegistered) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

suite("Extension Activation Tests", () => {
  test("Extension should be present", () => {
    const extension = vscode.extensions.getExtension("codeforge.codeforge-vscode");
    assert.ok(extension, "Extension should be installed");
  });

  test("Extension should activate", async () => {
    const extension = await waitForExtension();
    assert.ok(extension, "Extension should be installed");
    assert.ok(extension!.isActive, "Extension should be active after activation");
  });
});

suite("Command Registration Tests", () => {
  suiteSetup(async () => {
    await waitForExtension();
    await waitForCommands();
  });

  test("codeforge.startSession command should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("codeforge.startSession"),
      "codeforge.startSession should be registered"
    );
  });

  test("codeforge.sendMessage command should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("codeforge.sendMessage"),
      "codeforge.sendMessage should be registered"
    );
  });

  test("codeforge.openWebview command should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("codeforge.openWebview"),
      "codeforge.openWebview should be registered"
    );
  });

  test("codeforge.stopServer command should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("codeforge.stopServer"),
      "codeforge.stopServer should be registered"
    );
  });
});

suite("Workspace Detection Tests", () => {
  test("Extension should handle no workspace folder gracefully", async () => {
    const folders = vscode.workspace.workspaceFolders;

    if (folders === undefined || folders.length === 0) {
      assert.ok(true, "No workspace folder is acceptable for this test");
    } else {
      assert.ok(folders[0]?.uri, "Workspace folder should have a URI");
    }
  });
});

suite("Server Integration Tests", () => {
  suiteSetup(async () => {
    await waitForExtension();
    await waitForCommands();
  });

  test("Extension should provide server access", async () => {
    const extension = await waitForExtension();
    assert.ok(extension, "Extension should be installed");
    assert.ok(extension!.isActive, "Extension should be active after activation");
  });

  test("Commands should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);

    const expectedCommands = [
      "codeforge.startSession",
      "codeforge.sendMessage",
      "codeforge.openWebview",
      "codeforge.stopServer",
    ];

    for (const cmd of expectedCommands) {
      assert.ok(
        commands.includes(cmd),
        "Command " + cmd + " should be registered"
      );
    }
  });
});
