import { ModelQualificationReceiptSchema, roleQualificationStatusFor, type EightBitRole, type ModelQualificationReceipt } from "@codeforge/eight-bit";
import evidence from "./bundled-role-evidence.json" with { type: "json" };

export function bundledFreeRoleReceipts(nowMs: number): ModelQualificationReceipt[] {
  return evidence.flatMap(entry => {
    const parsed = ModelQualificationReceiptSchema.safeParse(entry.qualification);
    if (!parsed.success || !["kilo-free-direct", "blockrun-free-direct"].includes(parsed.data.providerId) || parsed.data.freeStatus !== "verified_free" || parsed.data.metadata?.transient) return [];
    if (Date.parse(parsed.data.completedAt) > nowMs) return [];
    const current = Object.keys(parsed.data.roleResults).some(role => roleQualificationStatusFor(parsed.data, role as EightBitRole, nowMs) === "QUALIFIED");
    return current ? [structuredClone(parsed.data)] : [];
  });
}
