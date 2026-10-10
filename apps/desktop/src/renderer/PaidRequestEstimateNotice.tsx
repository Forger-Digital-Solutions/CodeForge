import React, { useEffect, useState } from "react";
import type { PersonalPaidEstimateView } from "../paid-request-estimate-types.js";

export function formatPaidEstimate(value: number): string {
  return value === 0 ? "$0.00" : `$${value.toFixed(6)}`;
}

export default function PaidRequestEstimateNotice(): React.ReactElement | null {
  const [estimate, setEstimate] = useState<PersonalPaidEstimateView | null>(null);
  useEffect(() => {
    const stop = window.electronAPI?.onPersonalPaidEstimate?.(setEstimate);
    const stopAccount = window.electronAPI?.onCloudAccountChanged?.(() => setEstimate(null));
    return () => { stop?.(); stopAccount?.(); };
  }, []);
  useEffect(() => {
    if (!estimate) return;
    // Two frames let the committed notice paint before the host permits the wire request.
    let secondFrame: number | undefined;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => { void window.electronAPI?.acknowledgePersonalPaidEstimate?.(estimate.presentationId); });
    });
    return () => { cancelAnimationFrame(frame); if (secondFrame !== undefined) cancelAnimationFrame(secondFrame); };
  }, [estimate]);
  if (!estimate) return null;
  return <PaidEstimateContent estimate={estimate} dismiss={() => setEstimate(null)} />;
}

export function PaidEstimateContent({ estimate, dismiss }: { estimate: PersonalPaidEstimateView; dismiss: () => void }): React.ReactElement {
  return <aside role="status" aria-live="polite" style={{ position: "fixed", right: 16, bottom: 16, zIndex: 10000, maxWidth: 440, padding: "12px 16px", background: "#171717", color: "#eee", border: "1px solid #666", borderRadius: 6 }}>
    <strong>{estimate.purpose === "QUALIFICATION" ? "Paid qualification estimate" : "Paid request estimate"}: {formatPaidEstimate(estimate.estimatedCostUsd)} USD</strong>
    <p style={{ margin: "6px 0" }}>{estimate.providerId} · {estimate.maskedIdentity} · {estimate.modelId}</p>
    <p style={{ margin: 0 }}>Local budget remaining after reservation: {formatPaidEstimate(estimate.remainingBudgetUsd)} USD. Provider charges may exceed this estimate.</p>
    <button type="button" style={{ marginTop: 8 }} onClick={dismiss}>Dismiss estimate</button>
  </aside>;
}
