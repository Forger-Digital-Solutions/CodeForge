import { describe, expect, it } from "vitest";
import { classifyRegionEvidence, isTrustedRegionSource, regionGroupsForCountry } from "../src/region.js";

describe("regionGroupsForCountry", () => {
  it("classifies EEA member states", () => {
    expect(regionGroupsForCountry("DE")).toEqual(["EEA"]);
    expect(regionGroupsForCountry("fr")).toEqual(["EEA"]); // case-insensitive
  });
  it("classifies UK and Switzerland as their own groups, not EEA", () => {
    expect(regionGroupsForCountry("GB")).toEqual(["UK"]);
    expect(regionGroupsForCountry("CH")).toEqual(["CH"]);
  });
  it("returns an empty array for a non-regulated country", () => {
    expect(regionGroupsForCountry("US")).toEqual([]);
    expect(regionGroupsForCountry("JP")).toEqual([]);
  });
  it("returns an empty array for null", () => {
    expect(regionGroupsForCountry(null)).toEqual([]);
  });
});

describe("isTrustedRegionSource", () => {
  it("trusts only TRUSTED_EDGE_HEADER and ACCOUNT_BILLING_COUNTRY", () => {
    expect(isTrustedRegionSource("TRUSTED_EDGE_HEADER")).toBe(true);
    expect(isTrustedRegionSource("ACCOUNT_BILLING_COUNTRY")).toBe(true);
    expect(isTrustedRegionSource("USER_DECLARED")).toBe(false);
    expect(isTrustedRegionSource("UNKNOWN")).toBe(false);
  });
});

describe("classifyRegionEvidence", () => {
  it("resolves a trusted source to a concrete region", () => {
    const result = classifyRegionEvidence({ countryCode: "DE", source: "TRUSTED_EDGE_HEADER", observedAt: "2026-01-01T00:00:00.000Z" });
    expect(result.trusted).toBe(true);
    expect(result.groups).toEqual(["EEA"]);
    expect(result.countryCode).toBe("DE");
  });

  it("never trusts an untrusted source even when a country code is present", () => {
    const result = classifyRegionEvidence({ countryCode: "DE", source: "USER_DECLARED", observedAt: "2026-01-01T00:00:00.000Z" });
    expect(result.trusted).toBe(false);
    expect(result.groups).toEqual([]);
  });

  it("resolves to unknown when no country code is present even for a trusted source", () => {
    const result = classifyRegionEvidence({ countryCode: null, source: "TRUSTED_EDGE_HEADER", observedAt: "2026-01-01T00:00:00.000Z" });
    expect(result.trusted).toBe(false);
  });
});
