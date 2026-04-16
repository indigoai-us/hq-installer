// 02-cognito-auth.tsx — US-013
// Cognito authentication screen — sign in, sign up (email/password only)

import React, { useState } from "react";
import { signIn, signUp, confirmSignUp } from "@/lib/cognito";

interface CognitoAuthScreenProps {
  onNext?: () => void;
}

type Tab = "signin" | "signup";
type SignUpPhase = "form" | "confirm";

export function CognitoAuth({ onNext }: CognitoAuthScreenProps) {
  const [activeTab, setActiveTab] = useState<Tab>("signin");

  // Sign-in state
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signInLoading, setSignInLoading] = useState(false);

  // Sign-up state
  const [signUpEmail, setSignUpEmail] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");
  const [signUpConfirmPassword, setSignUpConfirmPassword] = useState("");
  const [signUpError, setSignUpError] = useState<string | null>(null);
  const [signUpLoading, setSignUpLoading] = useState(false);
  const [signUpPhase, setSignUpPhase] = useState<SignUpPhase>("form");

  // Confirm code state
  const [confirmCode, setConfirmCode] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  // Combined error for display
  const currentError =
    activeTab === "signin" ? signInError : signUpPhase === "form" ? signUpError : confirmError;

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setSignInError(null);
    setSignInLoading(true);
    try {
      await signIn(signInEmail, signInPassword);
      onNext?.();
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setSignInLoading(false);
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    if (signUpPassword !== signUpConfirmPassword) {
      setSignUpError("Passwords do not match");
      return;
    }
    setSignUpError(null);
    setSignUpLoading(true);
    try {
      await signUp(signUpEmail, signUpPassword);
      setSignUpPhase("confirm");
    } catch (err) {
      setSignUpError(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setSignUpLoading(false);
    }
  }

  async function handleConfirmSignUp(e: React.FormEvent) {
    e.preventDefault();
    setConfirmError(null);
    setConfirmLoading(true);
    try {
      await confirmSignUp(signUpEmail, confirmCode);
      await signIn(signUpEmail, signUpPassword);
      onNext?.();
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : "Confirmation failed");
    } finally {
      setConfirmLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-sm">
      <h1 className="text-2xl font-medium text-white">Create your account</h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/5 border border-white/10 rounded-full p-1">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "signin"}
          onClick={() => {
            setActiveTab("signin");
            setSignInError(null);
          }}
          className={`flex-1 py-1.5 rounded-full text-sm font-medium transition-colors ${
            activeTab === "signin"
              ? "bg-white text-black"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "signup"}
          onClick={() => {
            setActiveTab("signup");
            setSignUpError(null);
            setSignUpPhase("form");
          }}
          className={`flex-1 py-1.5 rounded-full text-sm font-medium transition-colors ${
            activeTab === "signup"
              ? "bg-white text-black"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          Sign up
        </button>
      </div>

      {/* Error display */}
      {currentError && (
        <div role="alert" className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-2">
          {currentError}
        </div>
      )}

      {/* Sign-in tab */}
      {activeTab === "signin" && (
        <form onSubmit={handleSignIn} className="flex flex-col gap-4">
          <input
            type="email"
            aria-label="Email"
            placeholder="Email"
            value={signInEmail}
            onChange={(e) => setSignInEmail(e.target.value)}
            autoComplete="email"
            required
            className="bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
          />
          <input
            type="password"
            aria-label="Password"
            placeholder="Password"
            value={signInPassword}
            onChange={(e) => setSignInPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
          />
          <button
            type="submit"
            disabled={signInLoading}
            className="rounded-full py-2.5 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-50"
          >
            {signInLoading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}

      {/* Sign-up tab */}
      {activeTab === "signup" && signUpPhase === "form" && (
        <form onSubmit={handleSignUp} className="flex flex-col gap-4">
          <input
            type="email"
            aria-label="Email"
            placeholder="Email"
            value={signUpEmail}
            onChange={(e) => setSignUpEmail(e.target.value)}
            autoComplete="email"
            required
            className="bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
          />
          <div className="flex flex-col gap-1.5">
            <input
              type="password"
              aria-label="Password"
              placeholder="Password"
              value={signUpPassword}
              onChange={(e) => setSignUpPassword(e.target.value)}
              autoComplete="new-password"
              required
              className="bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
            />
            <p className="text-xs text-zinc-500 px-4">
              At least 12 characters, with uppercase, lowercase, number, and symbol.
            </p>
          </div>
          <input
            type="password"
            aria-label="Confirm password"
            placeholder="Confirm password"
            data-testid="confirm-password"
            value={signUpConfirmPassword}
            onChange={(e) => setSignUpConfirmPassword(e.target.value)}
            autoComplete="new-password"
            required
            className="bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
          />
          <button
            type="submit"
            disabled={signUpLoading}
            className="rounded-full py-2.5 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-50"
          >
            {signUpLoading ? "Creating account…" : "Sign up"}
          </button>
        </form>
      )}

      {/* Confirm sign-up phase */}
      {activeTab === "signup" && signUpPhase === "confirm" && (
        <form onSubmit={handleConfirmSignUp} className="flex flex-col gap-4">
          <p className="font-light text-zinc-300 text-sm">
            Check your email for a verification code.
          </p>
          <input
            type="text"
            aria-label="Verification code"
            placeholder="Verification code"
            value={confirmCode}
            onChange={(e) => setConfirmCode(e.target.value)}
            autoComplete="one-time-code"
            required
            className="bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
          />
          {confirmError && (
            <div role="alert" className="text-sm text-red-400">
              {confirmError}
            </div>
          )}
          <button
            type="submit"
            disabled={confirmLoading}
            className="rounded-full py-2.5 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-50"
          >
            {confirmLoading ? "Confirming…" : "Confirm"}
          </button>
        </form>
      )}

    </div>
  );
}
