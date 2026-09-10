import React from "react";
import AuthScreen from "./AuthScreen.js";

interface OnboardingFlowProps {
  onComplete: () => void;
  onSkip: () => void;
}

/** Compatibility wrapper for older imports; first-run always uses the production AuthScreen. */
export default function OnboardingFlow({ onComplete }: OnboardingFlowProps): React.ReactElement {
  return <AuthScreen onAuthenticated={onComplete} />;
}
