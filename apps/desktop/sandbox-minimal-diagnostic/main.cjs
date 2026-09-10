const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const output = process.env.CODEFORGE_SANDBOX_MINIMAL_OUT;
const sandboxEnabled = process.env.CODEFORGE_SANDBOX_MINIMAL_MODE !== "renderer-sandbox-disabled";
let completed = false;

function record(value) {
  if (output) fs.appendFileSync(output, `${value}\n`, "utf8");
}

function finish(code) {
  if (completed) return;
  completed = true;
  setTimeout(() => app.exit(code), 50);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("in-process-gpu");

app.whenReady().then(async () => {
  record(`ELECTRON_VERSION=${process.versions.electron}`);
  record(`RENDERER_SANDBOX=${sandboxEnabled ? "enabled" : "disabled"}`);
  const window = new BrowserWindow({
    width: 640,
    height: 420,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: sandboxEnabled,
      webSecurity: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    record(`RENDER_PROCESS_GONE=${details.reason}:${details.exitCode}`);
    finish(2);
  });
  window.webContents.on("did-fail-load", (_event, code, description) => {
    record(`DID_FAIL_LOAD=${code}:${description}`);
    finish(3);
  });
  window.once("ready-to-show", () => record("READY_TO_SHOW"));
  window.webContents.once("did-finish-load", async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const mounted = await window.webContents.executeJavaScript("Boolean(document.querySelector('#root')?.children.length)");
      if (!mounted) throw new Error("CodeForge renderer did not mount");
      record("FIRST_PAINT=PASS");
      finish(0);
    } catch (error) {
      record(`RENDERER_ASSERTION_FAILED=${error instanceof Error ? error.message : String(error)}`);
      finish(4);
    }
  });

  setTimeout(() => {
    record("FIRST_PAINT_TIMEOUT");
    finish(5);
  }, 15000);
  await window.loadFile(path.join(__dirname, "renderer", "index.html"));
}).catch((error) => {
  record(`MAIN_FAILED=${error instanceof Error ? error.message : String(error)}`);
  finish(6);
});
