// 02-cognito-auth.tsx
// Sign in via Cognito Hosted UI (OAuth loopback + PKCE).
//
// When the user clicks a provider button, we:
//   1. Generate a PKCE verifier/challenge + opaque state token.
//   2. Kick off the Rust `oauth_listen_for_code` command — it binds
//      127.0.0.1:53682 and blocks until the browser hits /callback.
//   3. Open the Cognito /oauth2/authorize URL in the system browser so the
//      user sees Google's real consent screen (not an embedded webview —
//      Google blocks those).
//   4. Await the Rust promise → get the authorization code.
//   5. Exchange code + verifier for tokens at /oauth2/token.
//   6. Store tokens in the macOS keychain via the existing helpers.
//   7. Advance the wizard.

import React, { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openInBrowser } from "@tauri-apps/plugin-shell";
import { getUserFromTokens, storeTokens } from "@/lib/cognito";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generatePkce,
  generateState,
  getDefaultConfig,
  SIGN_IN_PROVIDERS,
  type SignInProvider,
} from "@/lib/google-oauth";
import { getWizardState, setGitIdentity } from "@/lib/wizard-state";
import { postOptIn } from "@/lib/telemetry";

interface CognitoAuthScreenProps {
  onNext?: () => void;
}

interface OAuthResult {
  code: string;
}

export function CognitoAuth({ onNext }: CognitoAuthScreenProps) {
  const [loadingProvider, setLoadingProvider] = useState<SignInProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Monotonic call counter. If the user re-clicks a provider button
  // while a prior OAuth flow is still in flight (browser tab closed, wrong
  // window, etc.), the Rust side cancels the old loopback listener — which
  // rejects the old listenerPromise with "Sign-in cancelled." We use this
  // ref to swallow that stale rejection so it doesn't overwrite the new
  // attempt's loading/error state.
  const currentCallRef = useRef(0);

  async function handleSignIn(provider: SignInProvider) {
    const myCall = ++currentCallRef.current;
    setError(null);
    setLoadingProvider(provider);
    try {
      const config = getDefaultConfig();
      const pkce = await generatePkce();
      const state = generateState();
      const authorizeUrl = buildAuthorizeUrl({
        config,
        state,
        codeChallenge: pkce.challenge,
        provider,
      });

      // Start the loopback listener FIRST so we never miss the redirect,
      // then open the browser. The listener awaits the GET /callback.
      // The Rust command auto-cancels any prior invocation so re-clicks
      // transparently reopen the browser.
      const listenerPromise = invoke<OAuthResult>("oauth_listen_for_code", {
        expectedState: state,
      });

      await openInBrowser(authorizeUrl);

      const { code } = await listenerPromise;
      if (myCall !== currentCallRef.current) return;
      const tokens = await exchangeCodeForTokens({
        config,
        code,
        verifier: pkce.verifier,
      });
      if (myCall !== currentCallRef.current) return;
      await storeTokens(tokens);
      if (myCall !== currentCallRef.current) return;
      // Pre-populate wizard state with the Cognito email so Step 10 (Summary)
      // can display it even if the user skips git-init or doesn't change the email.
      // Best-effort — a decode failure must never block sign-in advancement.
      try {
        const user = getUserFromTokens(tokens);
        if (user?.email) {
          setGitIdentity(user.name ?? "", user.email);
        }
      } catch (err) {
        console.warn("[oauth] could not decode idToken for wizard pre-fill:", err);
      }
      if (myCall !== currentCallRef.current) return;
      // Fire-and-forget: postOptIn handles retries + local cache internally.
      // We do not await it so the wizard advances without blocking on network.
      postOptIn({
        accessToken: tokens.accessToken,
        enabled: getWizardState().telemetryEnabled,
      }).catch(() => {});
      onNext?.();
    } catch (err) {
      // Swallow errors that belong to a superseded attempt — the fresh call
      // owns the UI now.
      if (myCall !== currentCallRef.current) return;
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err);
      // Surface in the webview console as well so right-click → Inspect shows it.
      console.error("[oauth] sign-in failed:", err);
      setError(msg || "Sign-in failed");
    } finally {
      if (myCall === currentCallRef.current) setLoadingProvider(null);
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-sm">
      <h1 className="text-2xl font-medium text-white">Sign in</h1>
      <p className="text-sm text-zinc-400 -mt-4">
        Use Google or Microsoft to continue setting up HQ.
      </p>

      {error && (
        <div
          role="alert"
          className="text-sm text-zinc-400 bg-white/5 border border-white/10 rounded-xl px-4 py-2"
        >
          {error}
        </div>
      )}

      <div className="grid gap-3">
        {SIGN_IN_PROVIDERS.map((provider) => (
          <button
            key={provider.key}
            type="button"
            onClick={() => handleSignIn(provider.key)}
            disabled={loadingProvider !== null}
            className="flex items-center justify-center gap-3 rounded-full py-2.5 text-sm font-medium bg-white text-black hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
          >
            {provider.key === "Google" ? <GoogleGlyph /> : <MicrosoftGlyph />}
            {loadingProvider === provider.key
              ? `Reopen ${provider.label} sign-in`
              : `Continue with ${provider.label}`}
          </button>
        ))}
      </div>

      {loadingProvider && (
        <p className="text-xs text-zinc-500 text-center">
          A browser window opened for {loadingProvider} sign-in. Complete it there and
          you'll return here automatically. If the tab closed or opened in the
          wrong window, click the button above to try again.
        </p>
      )}
    </div>
  );
}

function MicrosoftGlyph(): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className="grid size-[18px] shrink-0 grid-cols-2 gap-0.5"
    >
      <span className="bg-[#f25022]" />
      <span className="bg-[#7fba00]" />
      <span className="bg-[#00a4ef]" />
      <span className="bg-[#ffb900]" />
    </span>
  );
}

function GoogleGlyph(): React.ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.579c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.892 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}
