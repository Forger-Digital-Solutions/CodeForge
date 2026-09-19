import React, { useEffect, useState } from "react";

interface AuthScreenProps {
  onAuthenticated: () => void;
}

import { PRODUCT_LINKS, isConfiguredLink } from "./product-links.js";

const PRIVACY_URL = PRODUCT_LINKS.privacyPolicy;
const TERMS_URL = PRODUCT_LINKS.termsOfService;
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

function GitHubMark(): React.ReactElement {
  return (
    <svg className="github-mark" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
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
        <h1 id="auth-title">Your AI coding agent.</h1>
        <p className="auth-subtitle">
          Build, fix, and understand software with an agent that works directly with your project.
        </p>
        <p className="auth-subtitle auth-subtitle-detail">
          CodeForge can explore your codebase, edit files, run commands and tests, and show you exactly what it changed.
        </p>
        <p className="auth-free-note">
          Start free with CodeForge-managed AI models. No API key required.
        </p>
        {error && <AuthErrorMessage message={error} />}
        {!checkingAck && (
          <label className="auth-first-run-ack">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>
              I’m 18 or older and understand that CodeForge can read and modify project files and run commands on
              this computer according to my approval settings.
            </span>
          </label>
        )}
        <button
          type="button"
          className="auth-github-button"
          onClick={() => void signIn()}
          disabled={signingIn || checkingAck || !acknowledged}
        >
          <GitHubMark />
          {signingIn ? "Opening GitHub…" : "Continue with GitHub"}
        </button>
        <p className="auth-identity-note">
          GitHub sign-in creates your free CodeForge account. Connect repositories or your own AI providers later
          if you want — neither is required to start using CodeForge Free.
        </p>
        {(isConfiguredLink(TERMS_URL) || isConfiguredLink(PRIVACY_URL)) && (
          <p className="auth-legal-note">
            By continuing, you agree to the{" "}
            {isConfiguredLink(TERMS_URL) ? (
              <button type="button" className="auth-legal-link" onClick={() => void window.electronAPI?.openExternal?.(TERMS_URL)}>Terms of Service</button>
            ) : (
              "Terms of Service"
            )}{" "}
            and acknowledge the{" "}
            {isConfiguredLink(PRIVACY_URL) ? (
              <button type="button" className="auth-legal-link" onClick={() => void window.electronAPI?.openExternal?.(PRIVACY_URL)}>Privacy Policy</button>
            ) : (
              "Privacy Policy"
            )}
            .
          </p>
        )}
      </section>
    </main>
  );
}
