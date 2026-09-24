import { spawn } from "node:child_process";
import { getSanitizedEnvForChild } from "@codeforge/secrets";
import { ComputerUseError, COMPUTER_USE_ERRORS } from "./policy.js";

/**
 * Desktop input/capture backend. The Windows implementation drives the real session through
 * PowerShell + .NET (System.Drawing capture, user32 SetCursorPos/mouse_event/SendInput) — no
 * native modules, no bundled drivers. Every call is a fresh, time-boxed, environment-scrubbed
 * child so a wedged helper can never hold the desktop hostage.
 *
 * Scripts are passed as UTF-16LE base64 (-EncodedCommand): no quoting, no injection of tool
 * arguments into the command line beyond encoded script text, and parameters travel inside
 * the script as literals serialized by the backend itself.
 */

export interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapturedFrame {
  png: Buffer;
  bounds: ScreenBounds;
}

/**
 * One control in the UI Automation tree, captured as plain data — a UIA element handle is
 * volatile and never crosses the process boundary. `runtimeId` is the serialized UIA
 * RuntimeId: stable only within the target process's current UI state, so consumers must
 * re-resolve after any UI change instead of caching elements.
 */
export interface UiaElement {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  processId: number;
  enabled: boolean;
  offscreen: boolean;
  hasKeyboardFocus: boolean;
  bounds: ScreenBounds;
  runtimeId: string;
}

export interface ComputerBackend {
  isSupported(): boolean;
  screenBounds(): Promise<ScreenBounds>;
  capturePng(multiMonitor: boolean): Promise<CapturedFrame>;
  /**
   * Enumerate the UI Automation control view of the whole desktop, capped at maxElements.
   * Disabled controls are included (a greyed-out button is still something the operator can
   * see); elements with neither a name nor an automation id are dropped as unactionable.
   */
  uiaElements(maxElements: number): Promise<UiaElement[]>;
  setCursorPosition(x: number, y: number): Promise<void>;
  click(x: number, y: number, button: "left" | "right" | "middle", count: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKeys(vkCodes: number[]): Promise<void>;
}

export interface RunnerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Executes an EncodedCommand-ready PowerShell script body. Injectable for tests. */
export type ComputerRunner = (scriptBody: string, timeoutMs: number) => Promise<RunnerResult>;

const RUN_TIMEOUT_MS = 15_000;

function encodeScript(body: string): string {
  return Buffer.from(body, "utf16le").toString("base64");
}

export const defaultComputerRunner: ComputerRunner = (scriptBody, timeoutMs) =>
  new Promise<RunnerResult>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeScript(scriptBody)],
      {
        env: getSanitizedEnvForChild(),
        cwd: process.env.SystemRoot ?? "C:\\Windows",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_BACKEND_FAILED, "desktop backend call timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_BACKEND_FAILED, `desktop backend spawn failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

/**
 * The backend process must be DPI-aware or Windows virtualizes coordinates: on scaled
 * displays SetCursorPos/CopyFromScreen/GetCursorPos would see a shrunken logical grid that
 * disagrees with physical pixels (and clamps on secondary monitors). Set once per script.
 */
const DPI_PREAMBLE =
  // OutputEncoding must be UTF-8: the default OEM codepage silently rewrites
  // non-ASCII characters (e.g. U+2192 → becomes byte 0x1A in cp437), which lands
  // as raw control characters inside JSON payloads and breaks parsing.
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $d=Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v);' -Name Dpi -Namespace CfComputer -PassThru; [void][CfComputer.Dpi]::SetProcessDpiAwarenessContext([System.IntPtr]::new(-4));";

const USER32_DECL =
  "$u=Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X,int Y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint x,uint y,uint d,System.UIntPtr e); [StructLayout(LayoutKind.Sequential)] public struct KBD { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; } [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public KBD ki; } [StructLayout(LayoutKind.Sequential)] public struct INP { public uint type; public U u; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n,INP[] p,int cb); public static void SendUnicodeKey(ushort scan) { var k=new KBD(); k.wScan=scan; k.dwFlags=4; var u=new U(); u.ki=k; var i=new INP(); i.type=1; i.u=u; SendInput(1,new INP[]{i},System.Runtime.InteropServices.Marshal.SizeOf(i)); k.dwFlags=6; u.ki=k; i.u=u; SendInput(1,new INP[]{i},System.Runtime.InteropServices.Marshal.SizeOf(i)); } public static void SendVk(ushort vk,bool keyUp) { var k=new KBD(); k.wVk=vk; k.dwFlags=keyUp?2u:0u; var u=new U(); u.ki=k; var i=new INP(); i.type=1; i.u=u; SendInput(1,new INP[]{i},System.Runtime.InteropServices.Marshal.SizeOf(i)); }' -Name U32 -Namespace CfComputer -PassThru;";

const MOUSE_FLAGS: Record<"left" | "right" | "middle", { down: number; up: number }> = {
  left: { down: 0x2, up: 0x4 },
  right: { down: 0x8, up: 0x10 },
  middle: { down: 0x20, up: 0x40 },
};

export class WindowsComputerBackend implements ComputerBackend {
  constructor(private readonly runner: ComputerRunner = defaultComputerRunner) {}

  isSupported(): boolean {
    return process.platform === "win32";
  }

  private async run(script: string): Promise<string> {
    const result = await this.runner(`${DPI_PREAMBLE} ${script}`, RUN_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new ComputerUseError(
        COMPUTER_USE_ERRORS.COMPUTER_BACKEND_FAILED,
        `desktop backend exited ${result.code}: ${result.stderr.trim().slice(0, 300) || result.stdout.trim().slice(0, 300)}`,
      );
    }
    return result.stdout.trim();
  }

  async screenBounds(): Promise<ScreenBounds> {
    const out = await this.run(
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::VirtualScreen | Select-Object X,Y,Width,Height | ConvertTo-Json -Compress",
    );
    let parsed: { X?: number; Y?: number; Width?: number; Height?: number };
    try {
      parsed = JSON.parse(out) as typeof parsed;
    } catch {
      throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_BACKEND_FAILED, `unparseable screen bounds: ${out.slice(0, 120)}`);
    }
    if (typeof parsed.X !== "number" || typeof parsed.Y !== "number" || typeof parsed.Width !== "number" || typeof parsed.Height !== "number") {
      throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_BACKEND_FAILED, `malformed screen bounds: ${out.slice(0, 120)}`);
    }
    return { x: parsed.X, y: parsed.Y, width: parsed.Width, height: parsed.Height };
  }

  async capturePng(multiMonitor: boolean): Promise<CapturedFrame> {
    const region = multiMonitor
      ? "[System.Windows.Forms.SystemInformation]::VirtualScreen"
      : "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds";
    const out = await this.run(
      [
        "Add-Type -AssemblyName System.Drawing,System.Windows.Forms;",
        `$vs=${region};`,
        "$bmp=New-Object System.Drawing.Bitmap($vs.Width,$vs.Height);",
        "$g=[System.Drawing.Graphics]::FromImage($bmp);",
        "$g.CopyFromScreen($vs.Left,$vs.Top,0,0,$bmp.Size);",
        "$ms=New-Object System.IO.MemoryStream;",
        "$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png);",
        "$g.Dispose(); $bmp.Dispose();",
        `Write-Output ('{"x":'+$vs.X+',"y":'+$vs.Y+',"width":'+$vs.Width+',"height":'+$vs.Height+'}');`,
        "Write-Output ([Convert]::ToBase64String($ms.ToArray()));",
      ].join(" "),
    );
    const lines = out.split(/\r?\n/).filter((l) => l.length > 0);
    const boundsJson = lines[0];
    const b64 = lines.slice(1).join("");
    if (!boundsJson || !b64) {
      throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_BACKEND_FAILED, `capture produced no frame: ${out.slice(0, 160)}`);
    }
    const parsed = JSON.parse(boundsJson) as { x: number; y: number; width: number; height: number };
    return { png: Buffer.from(b64, "base64"), bounds: parsed };
  }

  async uiaElements(maxElements: number): Promise<UiaElement[]> {
    const max = Math.max(1, Math.min(2000, Math.floor(maxElements)));
    const out = await this.run(
      [
        "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes;",
        "$root=[System.Windows.Automation.AutomationElement]::RootElement;",
        // Control view is defined as IsControlElement=true. The static
        // Condition.ControlViewCondition composes an AndCondition that materializes as
        // null on some .NET/PowerShell combinations — constructing the equivalent
        // PropertyCondition directly works on both.
        "$cv=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsControlElementProperty,$true);",
        "$els=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$cv);",
        "$out=@(); $i=0;",
        "foreach ($e in $els) {",
        `  if ($i -ge ${max}) { break }`,
        "  $c=$e.Current;",
        "  if ([string]::IsNullOrWhiteSpace($c.Name) -and [string]::IsNullOrWhiteSpace($c.AutomationId)) { continue }",
        "  $r=$c.BoundingRectangle;",
        // ConvertTo-Json passes raw C0/DEL control characters through into string
        // literals, producing invalid JSON — real element names carry them
        // (observed U+001A in a live "Restart to Update" button).
        "  $clean={ param($s) ([string]$s) -replace '[\\x00-\\x1F\\x7F]','' };",
        "  $out += [pscustomobject]@{",
        "    name=(&$clean $c.Name); automationId=(&$clean $c.AutomationId);",
        "    controlType=[string]$c.ControlType.ProgrammaticName; className=(&$clean $c.ClassName);",
        "    processId=[int]$c.ProcessId; enabled=[bool]$c.IsEnabled; offscreen=[bool]$c.IsOffscreen;",
        "    hasKeyboardFocus=[bool]$c.HasKeyboardFocus;",
        "    bounds=@{x=[double]$r.X; y=[double]$r.Y; width=[double]$r.Width; height=[double]$r.Height};",
        "    runtimeId=(($e.GetRuntimeId()) -join '.');",
        "  };",
        "  $i++;",
        "}",
        "if ($out.Count -eq 0) { Write-Output '[]' } else { $out | ConvertTo-Json -Compress -Depth 4 }",
      ].join(" "),
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_BACKEND_FAILED, `unparseable UI Automation tree: ${out.slice(0, 200)}`);
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((item): item is UiaElement => typeof item === "object" && item !== null);
  }

  async setCursorPosition(x: number, y: number): Promise<void> {
    await this.run(`${USER32_DECL} [void][CfComputer.U32]::SetCursorPos(${Math.round(x)},${Math.round(y)});`);
  }

  async click(x: number, y: number, button: "left" | "right" | "middle", count: number): Promise<void> {
    const flags = MOUSE_FLAGS[button];
    const events = Array.from({ length: count }, () =>
      `[CfComputer.U32]::mouse_event(${flags.down},0,0,0,[System.UIntPtr]::Zero); [CfComputer.U32]::mouse_event(${flags.up},0,0,0,[System.UIntPtr]::Zero); Start-Sleep -Milliseconds 40;`,
    ).join(" ");
    await this.run(`${USER32_DECL} [void][CfComputer.U32]::SetCursorPos(${Math.round(x)},${Math.round(y)}); Start-Sleep -Milliseconds 30; ${events}`);
  }

  async typeText(text: string): Promise<void> {
    // UTF-16 code units are injected with KEYEVENTF_UNICODE so arbitrary text survives any
    // keyboard layout. Each unit is a down+up pair; units are serialized as literals, never
    // spliced into command text.
    const units: number[] = [];
    for (const ch of text) units.push(ch.charCodeAt(0));
    const body = units.map((u) => `[CfComputer.U32]::SendUnicodeKey(${u});`).join(" ");
    await this.run(`${USER32_DECL} ${body}`);
  }

  async pressKeys(vkCodes: number[]): Promise<void> {
    const down = vkCodes.map((vk) => `[CfComputer.U32]::SendVk(${vk},$false);`).join(" ");
    const up = [...vkCodes].reverse().map((vk) => `[CfComputer.U32]::SendVk(${vk},$true);`).join(" ");
    await this.run(`${USER32_DECL} ${down} Start-Sleep -Milliseconds 20; ${up}`);
  }
}
