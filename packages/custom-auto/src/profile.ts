import { z } from "zod";
import type { TrustDomain } from "@codeforge/forge-auto";

/**
 * Custom AUTO profiles (R1 spec §25–§28). A Custom AUTO is the user's OWN adaptive routing
 * team: user-owned APIs, user credentials, user's chosen models — including paid ones. It is
 * a separate trust domain (USER_CUSTOM_AUTO) from Forge Auto/Free (§29): a profile may NEVER
 * resolve through CodeForge-managed free capacity, and Forge Auto/Free may NEVER resolve
 * through a profile's user credentials.
 */

export const TRUST_DOMAIN: TrustDomain = "USER_CUSTOM_AUTO";

export const CUSTOM_AUTO_SEATS = ["planner", "coder", "reviewer", "verifier"] as const;
export type CustomAutoSeat = (typeof CUSTOM_AUTO_SEATS)[number];

export const CustomAutoRouteSchema = z.object({
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128).optional(),
});
export type CustomAutoRoute = z.infer<typeof CustomAutoRouteSchema>;

export const CustomAutoProfileSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    name: z.string().min(1).max(80),
    description: z.string().max(256).optional(),
    /** Seat → explicit user-configured route. At least one seat required. */
    roles: z.object({
      planner: CustomAutoRouteSchema.optional(),
      coder: CustomAutoRouteSchema,
      reviewer: CustomAutoRouteSchema.optional(),
      verifier: CustomAutoRouteSchema.optional(),
    }),
    /** Seat execution order — planner before coder when both exist. */
    fallbackOrder: z.array(z.enum(CUSTOM_AUTO_SEATS)).max(4).optional(),
    maxActiveSpecialists: z.number().int().min(1).max(4).default(4),
    /** "auto" optimizes seat assignment; "pinned" honors exactly what the user configured. */
    mode: z.enum(["auto", "pinned", "hybrid"]).default("pinned"),
    verificationStrictness: z.enum(["LIGHT", "STANDARD", "EXTENSIVE"]).default("STANDARD"),
    /** Trust-domain literal — asserted at every execution boundary (§29). */
    trustDomain: z.literal(TRUST_DOMAIN),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CustomAutoProfile = z.infer<typeof CustomAutoProfileSchema>;

/** Providers whose credentials belong to CodeForge-managed Free capacity. A Custom AUTO never
 * resolves through these (§23: managed Free routes are Forge Auto/Free's exclusive domain),
 * and — symmetrically — Forge Auto/Free never resolves through user providers. */
export const MANAGED_FREE_PROVIDER_IDS: readonly string[] = ["codeforge", "codeforge-cloud", "fds-gateway"];

export class TrustDomainViolationError extends Error {
  readonly code = "TRUST_DOMAIN_VIOLATION";
  constructor(message: string) {
    super(message);
    this.name = "TrustDomainViolationError";
  }
}

/** Hard execution-boundary assertion (§29): catches a generic router bug before credentials
 * cross domains. UI hiding is never the only guard. */
export function assertTrustDomain(expected: TrustDomain, actual: TrustDomain, context: string): void {
  if (expected !== actual) {
    throw new TrustDomainViolationError(
      `TRUST_DOMAIN_VIOLATION: ${context} expected trust domain ${expected} but execution carried ${actual}`,
    );
  }
}

export function validateCustomAutoProfile(value: unknown): { ok: true; profile: CustomAutoProfile } | { ok: false; error: string } {
  const parsed = CustomAutoProfileSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const profile = parsed.data;
  for (const [seat, route] of Object.entries(profile.roles) as Array<[CustomAutoSeat, CustomAutoRoute | undefined]>) {
    if (!route) continue;
    if (MANAGED_FREE_PROVIDER_IDS.includes(route.providerId)) {
      return {
        ok: false,
        error: `Role ${seat} may not use CodeForge-managed free provider "${route.providerId}" — managed Free capacity belongs to Forge Auto/Free only`,
      };
    }
  }
  return { ok: true, profile };
}
