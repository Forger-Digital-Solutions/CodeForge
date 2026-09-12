import React from "react";
import { useSettings } from "../settings-context.js";
import { SettingsGroup, SettingsRow, StatusBadge } from "../settings-controls.js";

/**
 * GEMS product layer (Topaz / Sapphire / Peridot / Garnet). GEMS models appear in the canonical
 * catalog but never route like free models: running one requires a CodeForge entitlement, which
 * no account currently holds, so every GEMS renders truthfully as Coming soon. The specializations
 * are the authoritative GEMS product metadata.
 */
interface GemInfo {
  /** Matches the GEMS model ids registered in the server catalog. */
  match: (modelId: string) => boolean;
  name: string;
  specialization: string;
  description: string;
}

const GEMS: GemInfo[] = [
  {
    match: (id) => /topaz/i.test(id),
    name: "Topaz",
    specialization: "Fast Autonomous",
    description: "Speed-tuned autonomous work with a 128k context window.",
  },
  {
    match: (id) => /sapphire/i.test(id),
    name: "Sapphire",
    specialization: "Deep Reasoning",
    description: "Heavy multi-step reasoning with a 200k context window.",
  },
  {
    match: (id) => /peridot/i.test(id),
    name: "Peridot",
    specialization: "Specialized Toolchain",
    description: "Tool-heavy engineering workflows with a 128k context window.",
  },
  {
    match: (id) => /garnet/i.test(id),
    name: "Garnet",
    specialization: "Ultra Architecture",
    description: "Whole-repository architecture work with a 1M-token context window and vision.",
  },
];

export function GemsSection(): React.ReactElement {
  const ctx = useSettings();
  const catalog = ctx.apiModels.filter((m) => m.tier === "gems_paid");

  return (
    <div>
      <h1 className="settings-section-title">GEMS</h1>
      <p className="settings-section-subtitle">
        GEMS is CodeForge's first-party premium model layer — a product layer above the free
        catalog, not a provider. Running a GEMS model will always require a CodeForge entitlement;
        it never silently substitutes a paid route into free work.
      </p>

      <SettingsGroup title="GEMS models">
        {GEMS.map((gem) => {
          const inCatalog = catalog.find((m) => gem.match(m.id) || gem.match(m.displayName));
          return (
            <SettingsRow
              key={gem.name}
              title={`${gem.name} — ${gem.specialization}`}
              description={inCatalog ? `${gem.description} Present in the current catalog as ${inCatalog.displayName}.` : gem.description}
              control={<StatusBadge kind="info">Coming soon</StatusBadge>}
            />
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="Availability">
        <SettingsRow
          title="Entitlements"
          description="No CodeForge entitlement grants GEMS access yet. When a GEMS entitlement becomes available for your account, its status will appear here."
          control={<StatusBadge kind="info">Unavailable</StatusBadge>}
        />
      </SettingsGroup>
    </div>
  );
}
