#!/usr/bin/env node
/**
 * Live Free-Model Catalog Snapshot Generator
 *
 * Runs production FreeModelCatalogRefresh against connected providers with credentials,
 * generates a timestamped VERIFIED_FREE catalog snapshot, and saves it to disk.
 *
 * Usage:
 *   npx tsx scripts/generate-live-free-catalog.ts [--out ./snapshots]
 *
 * Requires: OPENCODE_API_KEY, OPENROUTER_API_KEY in environment for live discovery.
 */

import { createFreeModelCatalogRefresh } from "../packages/model-registry/src/catalog-refresh.js";
import { createProviderCatalog, createOpenRouterAdapter, createOpencodeAdapter } from "../packages/providers/src/index.js";
import { ForgeZero } from "../packages/forge-zero/src/index.js";
import { createEightBitRuntime } from "../packages/eight-bit/src/index.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

interface SnapshotMetadata {
  generatedAt: string;
  generatorVersion: string;
  providersProbed: string[];
  totalModelsDiscovered: number;
  verifiedFreeModels: number;
  verificationResults: {
    providerId: string;
    modelsDiscovered: number;
    zeroUnitVerified: number;
    allowanceVerified: number;
    errors: string[];
  }[];
  notes: string;
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(projectRoot, "snapshots");

  // Ensure output directory exists
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // Build provider catalog with available credentials
  const catalog = createProviderCatalog();
  const adaptersToRegister: { id: string; adapter: any }[] = [];

  if (process.env.OPENCODE_API_KEY) {
    const opencode = createOpencodeAdapter({ baseUrl: "https://opencode.ai/zen/v1" });
    catalog.register(opencode);
    adaptersToRegister.push({ id: "opencode", adapter: opencode });
    console.log("[catalog] Registered opencode adapter");
  }

  if (process.env.OPENROUTER_API_KEY) {
    const openrouter = createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" });
    catalog.register(openrouter);
    adaptersToRegister.push({ id: "openrouter", adapter: openrouter });
    console.log("[catalog] Registered openrouter adapter");
  }

  if (adaptersToRegister.length === 0) {
    console.error("[catalog] No provider credentials found. Set OPENCODE_API_KEY and/or OPENROUTER_API_KEY.");
    console.error("[catalog] Generating snapshot from bundled snapshot only (no live verification).");
  }

  // Create the refresh orchestrator
  const firewall = new ForgeZero();
  const eightBit = createEightBitRuntime({});
  const refresh = createFreeModelCatalogRefresh({
    firewall,
    eightBit,
    providerCatalog: catalog,
    maxAllowanceProbes: 1,
    requireCredentials: true,
  });

  console.log("[catalog] Starting live free-model catalog refresh...");

  // Run the refresh
  const result = await refresh.refresh();

  console.log(`[catalog] Refresh complete:`);
  console.log(`  - Registry: ${result.registry.source} (${result.registry.modelCount} models)`);
  console.log(`  - Discovered: ${result.discovery.length} provider(s)`);
  console.log(`  - Verified free (zero-unit): ${result.discovery.reduce((s, d) => s + d.records.length, 0)}`);
  console.log(`  - Verified free (allowance): ${result.allowance.reduce((s, d) => s + d.records.length, 0)}`);
  console.log(`  - Registered in ForgeZero: ${result.registered}`);
  console.log(`  - Errors: ${result.errors.length}`);

  // Build snapshot metadata
  const verificationResults = [];
  for (let i = 0; i < result.discovery.length; i++) {
    const d = result.discovery[i];
    const a = result.allowance[i];
    verificationResults.push({
      providerId: d.providerId,
      modelsDiscovered: d.liveModels.length,
      zeroUnitVerified: d.records.length,
      allowanceVerified: a?.records.length ?? 0,
      errors: d.errors ?? [],
    });
  }

  const metadata: SnapshotMetadata = {
    generatedAt: new Date().toISOString(),
    generatorVersion: "1.0.0",
    providersProbed: adaptersToRegister.map((a) => a.id),
    totalModelsDiscovered: result.discovery.reduce((s, d) => s + d.liveModels.length, 0),
    verifiedFreeModels: result.registered,
    verificationResults,
    notes:
      "Snapshot generated via FreeModelCatalogRefresh. Only models independently verified through ForgeZero 8-gate pipeline are marked verified_free. Models.dev facts alone do not grant trust.",
  };

  // Generate the catalog snapshot (all FreeModelRecords from ForgeZero)
  const allModels = firewall.allModels();
  const verifiedFreeModels = allModels.filter((m) => m.freeStatus === "verified_free");
  const catalogSnapshot = {
    metadata,
    models: allModels,
  };

  // Save timestamped snapshot
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `verified-free-catalog-${timestamp}.json`;
  const filepath = join(outDir, filename);

  writeFileSync(filepath, JSON.stringify(catalogSnapshot, null, 2));
  console.log(`[catalog] Snapshot saved to: ${filepath}`);

  // Also save latest symlink/copy
  const latestPath = join(outDir, "verified-free-catalog-latest.json");
  writeFileSync(latestPath, JSON.stringify(catalogSnapshot, null, 2));
  console.log(`[catalog] Latest symlink updated: ${latestPath}`);

  // Print summary
  console.log("\n=== VERIFIED_FREE Catalog Summary ===");
  console.log(`Generated: ${metadata.generatedAt}`);
  console.log(`Providers probed: ${metadata.providersProbed.join(", ") || "none"}`);
  console.log(`Total models in catalog: ${allModels.length}`);
  console.log(`Verified free models: ${verifiedFreeModels.length}`);
  console.log(`Verification: ForgeZero 8-gate pipeline (independent, no Models.dev trust)`);

  if (verifiedFreeModels.length > 0) {
    console.log("\nVerified-free models:");
    for (const m of verifiedFreeModels) {
      const access = m.accessClass === "FREE_NATIVE" ? "native" : m.accessClass === "FREE_ROUTED" ? "routed" : "allowance";
      console.log(`  - ${m.providerId}/${m.modelId} [${access}] ${m.displayName}`);
    }
  }

  if (result.errors.length > 0) {
    console.log("\nErrors encountered:");
    for (const e of result.errors) {
      console.log(`  - ${e}`);
    }
  }

  process.exit(result.failed > 0 && result.registered === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[catalog] Fatal error:", e);
  process.exit(1);
});