import React, { useEffect, useState } from "react";

interface AuthScreenProps {
  onAuthenticated: () => void;
}

const PRIVACY_URL = "https://codeforge.dev/privacy";
const TERMS_URL = "https://codeforge.dev/terms";
const SIGN_IN_UNAVAILABLE = "CodeForge sign-in is unavailable right now. Check your connection and try again.";
const SIGN_IN_CANCELLED = "Sign-in was cancelled.";
const SIGN_IN_REJECTED = "We couldn't complete GitHub sign-in. Please try again.";

export function describeSignInFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  if (message === "CodeForge authentication is unavailable in this build.") return message;
  if (message === SIGN_IN_CANCELLED) return SIGN_IN_CANCELLED;
  if (message === SIGN_IN_REJECTED) return SIGN_IN_REJECTED;
  if (/timed out/i.test(message)) return "CodeForge sign-in timed out. Please try again.";
  return SIGN_IN_UNAVAILABLE;
}

export function AuthErrorMessage({ message }: { message: string }): React.ReactElement {
  return <div className="auth-error" role="alert">{message}</div>;
}

function CodeForgeMark(): React.ReactElement {
  return (
    <svg className="auth-mark" viewBox="0 0 256 256" fill="none" role="img" aria-label="CodeForge">
      <circle cx="128" cy="128" r="123" fill="#0b0c0e" stroke="#aeb4bd" strokeWidth="3" />
      <g fill="none" stroke="#d6d9df" strokeWidth="4" opacity="0.92">
        <ellipse cx="128" cy="128" rx="106" ry="44" transform="rotate(-18 128 128)" />
        <ellipse cx="128" cy="128" rx="106" ry="40" transform="rotate(42 128 128)" />
        <ellipse cx="128" cy="128" rx="100" ry="36" transform="rotate(78 128 128)" />
      </g>
      <path d="M128 57 178 106 128 119 78 106 128 57Z" fill="#f4f5f7" />
      <path d="M78 106 128 119 128 204 102 153 78 106Z" fill="#737b89" />
      <path d="M178 106 128 119 128 204 154 153 178 106Z" fill="#b8bec8" />
      <circle cx="193" cy="58" r="18" fill="#dce0e7" />
      <circle cx="43" cy="131" r="17" fill="#c5cbd5" />
      <circle cx="196" cy="195" r="14" fill="#9ea6b3" />
    </svg>
  );
}

export default function AuthScreen({ onAuthenticated }: AuthScreenProps): React.ReactElement {
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // R1 legal remediation: ENG-P1-02 (18+ age gate) and ENG-P1-03 (host-execution disclosure).
  // Combined into one first-run acknowledgement rather than two separate prompts, per the
  // instruction not to build a "giant legal modal" — this is the only gate every path through the
  // app passes today, so it is where both disclosures live.
  const [acknowledged, setAcknowledged] = useState(false);
  const [checkingAck, setCheckingAck] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ack = await window.electronAPI?.getFirstRunLegalAck?.();
        if (!cancelled) setAcknowledged(Boolean(ack));
      } finally {
        if (!cancelled) setCheckingAck(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = async (): Promise<void> => {
    if (!acknowledged) return;
    setSigningIn(true);
    setError(null);
    try {
      if (!window.electronAPI?.signInWithCloud) {
        throw new Error("CodeForge authentication is unavailable in this build.");
      }
      await window.electronAPI.setFirstRunLegalAck?.();
      const result = await window.electronAPI.signInWithCloud();
      if (!result.ok) {
        setError(describeSignInFailure(result.error));
        return;
      }
      onAuthenticated();
    } catch (cause) {
      setError(describeSignInFailure(cause));
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="auth-title">
        <CodeForgeMark />
        <div className="auth-wordmark">CODEFORGE</div>
        <h1 id="auth-title">Build software with AI.</h1>
        <p className="auth-subtitle">A free-first engineering workspace with durable, verifiable execution.</p>
        {error && <AuthErrorMessage message={error} />}
        {!checkingAck && !acknowledged && (
          <label className="auth-first-run-ack">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>
              I am 18 years of age or older, and I understand CodeForge reads/writes files and runs commands on this
              computer using my operating-system permissions. Review approval settings before allowing autonomous
              actions.
            </span>
          </label>
        )}
        <button
          type="button"
          className="auth-github-button"
          onClick={() => void signIn()}
          disabled={signingIn || checkingAck || !acknowledged}
        >
          <span className="github-glyph" aria-hidden="true">●</span>
          {signingIn ? "Opening GitHub…" : "Continue with GitHub"}
        </button>
        <p className="auth-identity-note">Your GitHub account is your CodeForge identity. Provider configuration comes after sign-in.</p>
        <div className="auth-links">
          <button type="button" onClick={() => void window.electronAPI?.openExternal?.(PRIVACY_URL)}>Privacy</button>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={() => void window.electronAPI?.openExternal?.(TERMS_URL)}>Terms</button>
        </div>
      </section>
    </main>
  );
}
