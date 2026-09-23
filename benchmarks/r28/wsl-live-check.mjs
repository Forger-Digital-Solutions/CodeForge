// R28 WSL live host check — real detection, translation, and governed exec.
import { detectWsl, execInWsl, windowsPathToWsl } from "../../packages/terminal/dist/wsl.js";

const det = detectWsl();
console.log("detection:", JSON.stringify({ available: det.available, distros: det.distros }));

for (const p of ["C:\\cf-wsl-test", "G:\\CodeForge", "\\\\server\\share"]) {
  console.log(`translate ${p} -> ${windowsPathToWsl(p)}`);
}

const ok = await execInWsl("pwd && uname -sr && echo WSL_MARKER_OK", { cwd: "C:\\cf-wsl-test" });
console.log("exec ok:", JSON.stringify({ exit: ok.exitCode, env: ok.environment, distro: ok.distro, cwd: ok.linuxCwd, out: ok.output.trim(), spawnError: ok.spawnError ?? null }));

const unmappable = await execInWsl("echo SHOULD_NOT_PRINT", { cwd: "G:\\CodeForge" });
console.log("unmappable:", JSON.stringify({ exit: unmappable.exitCode, spawnError: unmappable.spawnError ?? null, out: unmappable.output.trim() }));

const missing = await execInWsl("echo SHOULD_NOT_PRINT", { distro: "cf-no-such-distro" });
console.log("missing distro:", JSON.stringify({ exit: missing.exitCode, spawnError: missing.spawnError ?? null }));
