export type RegionGroupId = "EEA" | "UK" | "CH";

export interface RegionGroupDefinition {
  id: RegionGroupId;
  label: string;
  countryCodes: string[];
  version: string;
  authoritySource: string;
  reviewedAt: string;
}

// EU-27 + EEA-EFTA (Iceland, Liechtenstein, Norway). Switzerland and the UK are tracked as
// separate groups because Pass-3 evidence (docs/legal/pass3/final-issue-register.md LEG-P0-03)
// cites them as distinct jurisdictions in Google's Gemini API Additional Terms, even though
// product decisions often treat EEA+UK+CH as one "regulated region" bundle.
const EEA_COUNTRY_CODES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO",
];

export const REGION_GROUPS: Record<RegionGroupId, RegionGroupDefinition> = {
  EEA: {
    id: "EEA",
    label: "European Economic Area",
    countryCodes: EEA_COUNTRY_CODES,
    version: "2026-09-11.1",
    authoritySource: "EU-27 member states + EEA-EFTA states (Iceland, Liechtenstein, Norway), manually maintained",
    reviewedAt: "2026-09-11T00:00:00.000Z",
  },
  UK: {
    id: "UK",
    label: "United Kingdom",
    countryCodes: ["GB"],
    version: "2026-09-11.1",
    authoritySource: "ISO 3166-1 GB",
    reviewedAt: "2026-09-11T00:00:00.000Z",
  },
  CH: {
    id: "CH",
    label: "Switzerland",
    countryCodes: ["CH"],
    version: "2026-09-11.1",
    authoritySource: "ISO 3166-1 CH",
    reviewedAt: "2026-09-11T00:00:00.000Z",
  },
};

export function regionGroupsForCountry(countryCode: string | null): RegionGroupId[] {
  if (!countryCode) return [];
  const normalized = countryCode.toUpperCase();
  const groups: RegionGroupId[] = [];
  for (const group of Object.values(REGION_GROUPS)) {
    if (group.countryCodes.includes(normalized)) groups.push(group.id);
  }
  return groups;
}

// Where region evidence came from. Only TRUSTED_EDGE_HEADER and ACCOUNT_BILLING_COUNTRY are
// treated as trustworthy for enforcement — everything else (including a raw client-supplied
// header) resolves to REGION_UNKNOWN. See R1 remediation spec §12: "Region decisions must not
// trust arbitrary client-supplied headers."
export type RegionEvidenceSource =
  | "TRUSTED_EDGE_HEADER"
  | "ACCOUNT_BILLING_COUNTRY"
  | "USER_DECLARED"
  | "UNKNOWN";

export interface RegionEvidence {
  countryCode: string | null;
  source: RegionEvidenceSource;
  observedAt: string;
}

export interface RegionResolution {
  countryCode: string | null;
  groups: RegionGroupId[];
  trusted: boolean;
  source: RegionEvidenceSource;
}

const TRUSTED_SOURCES: ReadonlySet<RegionEvidenceSource> = new Set([
  "TRUSTED_EDGE_HEADER",
  "ACCOUNT_BILLING_COUNTRY",
]);

export function isTrustedRegionSource(source: RegionEvidenceSource): boolean {
  return TRUSTED_SOURCES.has(source);
}

export const REGION_UNKNOWN: RegionResolution = {
  countryCode: null,
  groups: [],
  trusted: false,
  source: "UNKNOWN",
};

// Pure classification: never reads headers/requests itself. The HTTP layer is responsible for
// building RegionEvidence from a documented, trusted source (see docs on TrustedRegionResolver
// in apps/cloud-api) and must default to {countryCode: null, source: "UNKNOWN"} when no such
// trusted source is configured for the current deployment.
export function classifyRegionEvidence(evidence: RegionEvidence): RegionResolution {
  if (!isTrustedRegionSource(evidence.source) || !evidence.countryCode) {
    return { ...REGION_UNKNOWN, source: evidence.source === "UNKNOWN" ? "UNKNOWN" : evidence.source };
  }
  return {
    countryCode: evidence.countryCode.toUpperCase(),
    groups: regionGroupsForCountry(evidence.countryCode),
    trusted: true,
    source: evidence.source,
  };
}
