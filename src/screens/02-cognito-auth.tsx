// 02-cognito-auth.tsx — US-013
// Cognito authentication screen — sign in, sign up, GitHub OAuth

import React, { useState } from "react";
import {
  signIn,
  signUp,
  confirmSignUp,
  signInWithGitHub,
} from "@/lib/cognito";

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

  // GitHub state
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);

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
      onNext?.();
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : "Confirmation failed");
    } finally {
      setConfirmLoading(false);
    }
  }

  async function handleGitHub() {
    setGithubError(null);
    setGithubLoading(true);
    try {
      await signInWithGitHub();
      onNext?.();
    } catch (err) {
      setGithubError(
        err instanceof Error ? err.message : "GitHub sign in failed"
      );
    } finally {
      setGithubLoading(false);
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
      {(currentError || githubError) && (
        <div role="alert" className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-2">
          {currentError || githubError}
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

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-white/10" />
        <span className="text-xs text-zinc-500">or</span>
        <div className="flex-1 h-px bg-white/10" />
      </div>

      {/* GitHub OAuth */}
      <button
        type="button"
        onClick={handleGitHub}
        disabled={githubLoading}
        className="rounded-full py-2.5 text-sm font-medium bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="currentColor"
          aria-hidden="true"
          className="text-zinc-400"
        >
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        {githubLoading ? "Opening GitHub…" : "Continue with GitHub"}
      </button>
    </div>
  );
}
