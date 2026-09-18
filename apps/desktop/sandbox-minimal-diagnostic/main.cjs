const { app, BrowserWindow } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const output = process.env.CODEFORGE_SANDBOX_MINIMAL_OUT;
const graphicsMode = process.env.CODEFORGE_SANDBOX_MINIMAL_GRAPHICS ?? "production-software";
const holdBeforeLoadMs = Number.parseInt(process.env.CODEFORGE_SANDBOX_MINIMAL_HOLD_BEFORE_LOAD_MS ?? "0", 10);
const holdAfterFailureMs = Number.parseInt(process.env.CODEFORGE_SANDBOX_MINIMAL_HOLD_AFTER_FAILURE_MS ?? "0", 10);
let completed = false;

function record(value) {
  if (output) fs.appendFileSync(output, `${value}\n`, "utf8");
}

function finish(code) {
  if (completed) return;
  completed = true;
  const exitDelay = Number.isSafeInteger(holdAfterFailureMs) && holdAfterFailureMs > 0 ? holdAfterFailureMs : 50;
  if (exitDelay > 50) record(`HOLD_AFTER_FAILURE_MS=${exitDelay}`);
  setTimeout(() => app.exit(code), exitDelay);
}

function recordFile(label, file) {
  const data = fs.readFileSync(file);
  record(`${label}=${JSON.stringify({ file, bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") })}`);
}

if (graphicsMode === "production-software") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("in-process-gpu");
} else if (graphicsMode !== "default") {
  throw new Error(`Unsupported graphics diagnostic mode: ${graphicsMode}`);
}

app.on("child-process-gone", (_event, details) => {
  record(`CHILD_PROCESS_GONE=${details.type}:${details.reason}:${details.exitCode}`);
});

app.whenReady().then(async () => {
  record(`ELECTRON_VERSION=${process.versions.electron}`);
  record(`CHROMIUM_VERSION=${process.versions.chrome}`);
  record(`NODE_VERSION=${process.versions.node}`);
  record(`EXECUTABLE_PATH=${process.execPath}`);
  record(`APP_PATH=${app.getAppPath()}`);
  record(`PACKAGED=${app.isPackaged}`);
  record(`GRAPHICS_MODE=${graphicsMode}`);
  record(`GPU_FEATURES=${JSON.stringify(app.getGPUFeatureStatus())}`);
  const rendererFile = path.join(__dirname, "index.html");
  const preloadFile = path.join(__dirname, "preload.cjs");
  recordFile("RENDERER_FILE", rendererFile);
  recordFile("PRELOAD_FILE", preloadFile);
  const rendererUrl = pathToFileURL(rendererFile).href;
  record(`RENDERER_URL=${rendererUrl}`);
  const window = new BrowserWindow({
    width: 640,
    height: 420,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: preloadFile,
    },
  });
  record("BROWSER_WINDOW_SECURITY=sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true");

  window.webContents.on("render-process-gone", (_event, details) => {
    record(`RENDER_PROCESS_GONE=${details.reason}:${details.exitCode}`);
    finish(2);
  });
  window.webContents.on("did-fail-load", (_event, code, description) => {
    record(`DID_FAIL_LOAD=${code}:${description}`);
    finish(3);
  });
  window.webContents.on("dom-ready", () => record("DOM_READY"));
  window.webContents.on("did-frame-finish-load", (_event, isMainFrame) => {
    if (isMainFrame) record("DID_FRAME_FINISH_LOAD");
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    record(`PRELOAD_ERROR=${path.basename(preloadPath)}:${error.message}`);
  });
  window.webContents.on("console-message", ({ level, message }) => {
    record(`CONSOLE_MESSAGE=${level}:${message.slice(0, 500).replace(/\s+/g, " ")}`);
  });
  window.once("ready-to-show", () => record("READY_TO_SHOW"));
  window.webContents.once("did-finish-load", async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const mounted = await window.webContents.executeJavaScript("document.querySelector('#status')?.textContent === 'sandbox-minimal'");
      if (!mounted) throw new Error("Minimal secure renderer did not mount");
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
  if (Number.isSafeInteger(holdBeforeLoadMs) && holdBeforeLoadMs > 0) {
    record(`HOLD_BEFORE_LOAD_MS=${holdBeforeLoadMs}`);
    await new Promise((resolve) => setTimeout(resolve, holdBeforeLoadMs));
  }
  await window.loadURL(rendererUrl);
}).catch((error) => {
  record(`MAIN_FAILED=${error instanceof Error ? error.message : String(error)}`);
  finish(6);
});
