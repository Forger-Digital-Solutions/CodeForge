/**
 * Consumer-side verification of PUBLIC GitHub Release assets against their
 * published SHA-256 checksums.
 *
 * This is a distribution/acceptance utility, not a build step: it uses only
 * Node builtins, needs no repository node_modules, and never rebuilds or
 * mutates the release binaries. It exists so the release-consumer-acceptance
 * workflow can prove that the exact bytes a user would download match the
 * certified hashes before any executable is run.
 *
 * CLI:
 *   node verify-release-hashes.mjs <dir> <SHA256SUMS.txt> [name=expectedHash ...]
 *
 * Every entry in the manifest must have a matching file in <dir> with a
 * matching SHA-256. Optional `name=hash` pins are authoritative: they must
 * agree with the manifest (if present) and with the file on disk. On success
 * the marker PUBLIC_RELEASE_HASHES_OK is printed and the process exits 0; any
 * mismatch, missing file, or malformed manifest exits non-zero.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Parse a `sha256sum`-style manifest into a Map of filename -> lowercase hex. */
export function parseSha256Sums(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // "<64 hex>  filename" or "<64 hex> *filename" (binary marker)
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!m) throw new Error(`Malformed SHA256SUMS line: ${raw}`);
    map.set(m[2].trim(), m[1].toLowerCase());
  }
  if (map.size === 0) throw new Error("SHA256SUMS manifest is empty");
  return map;
}

/** Compute the lowercase hex SHA-256 of a file. */
export function sha256OfFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Verify each expected file (Map name -> hex hash) against `dir`.
 * @returns {{ok: boolean, results: Array<{name:string, expected:string, actual:(string|null), status:('OK'|'MISMATCH'|'MISSING')}>}}
 */
export function verifyReleaseHashes(dir, expected) {
  const results = [];
  let ok = true;
  for (const [name, want] of expected) {
    const filePath = path.join(dir, name);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      results.push({ name, expected: want, actual: null, status: "MISSING" });
      ok = false;
      continue;
    }
    const got = sha256OfFile(filePath).toLowerCase();
    const match = got === want.toLowerCase();
    if (!match) ok = false;
    results.push({ name, expected: want.toLowerCase(), actual: got, status: match ? "OK" : "MISMATCH" });
  }
  return { ok, results };
}

/** Merge authoritative `name=hash` pins into the expected map, rejecting manifest disagreement. */
export function applyPins(expected, pins) {
  for (const arg of pins) {
    const eq = arg.indexOf("=");
    if (eq === -1) continue;
    const name = arg.slice(0, eq).trim();
    const hash = arg.slice(eq + 1).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Invalid pin hash for ${name}: ${hash}`);
    const inManifest = expected.get(name);
    if (inManifest && inManifest.toLowerCase() !== hash) {
      throw new Error(`AUTHORITATIVE MISMATCH: ${name} manifest=${inManifest} pin=${hash}`);
    }
    expected.set(name, hash);
  }
  return expected;
}

function main(argv) {
  const dir = argv[0];
  const sumsFile = argv[1];
  if (!dir || !sumsFile) {
    console.error("usage: verify-release-hashes.mjs <dir> <SHA256SUMS.txt> [name=expectedHash ...]");
    process.exit(2);
  }
  if (!existsSync(sumsFile)) {
    console.error(`SHA256SUMS file not found: ${sumsFile}`);
    process.exit(1);
  }
  let expected;
  try {
    expected = parseSha256Sums(readFileSync(sumsFile, "utf8"));
    applyPins(expected, argv.slice(2));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
  const { ok, results } = verifyReleaseHashes(dir, expected);
  for (const r of results) {
    console.log(`${r.status.padEnd(8)} ${r.name}  ${r.actual ?? "(absent)"}`);
  }
  if (!ok) {
    console.error("RELEASE HASH VERIFICATION FAILED");
    process.exit(1);
  }
  console.log("PUBLIC_RELEASE_HASHES_OK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
