// 03-team.tsx — US-004
// Company detection screen. Looks up the user's existing company from
// vault-service instead of creating a new one. Users provision their company
// during web onboarding — the installer just needs to find and confirm it.

import { useState, useEffect } from "react";
import { setTeam, setIsPersonal } from "@/lib/wizard-state";
import { getCurrentUser, signOut } from "@/lib/cognito";
import { resolveUserCompany } from "@/lib/vault-handoff";

interface CompanyDetectProps {
  onNext?: () => void;
  /** Sign the user out and route back to Screen 02 (optional — if omitted,
   *  the error UI only shows Try again). */
  onSignOutAndRetry?: () => void;
}

export function TeamSetup({ onNext, onSignOutAndRetry }: CompanyDetectProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [company, setCompany] = useState<{
    companyUid: string;
    companySlug: string;
    companyName: string;
    bucketName: string;
    personUid: string;
    role: string;
  } | null>(null);
  // Bumping this counter re-runs the effect. This replaces an older ref-based
  // guard that kept the effect from re-firing but also prevented the Try again
  // button from actually retriggering detect() — retries state-updated without
  // ever restarting the lookup.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function detect() {
      try {
        const user = await getCurrentUser();
        if (cancelled) return;
        if (!user) {
          setError("No active session — please sign in again.");
          setLoading(false);
          return;
        }

        const result = await resolveUserCompany(user.tokens.accessToken, {
          ownerSub: user.sub,
          displayName: user.name ?? user.email.split("@")[0] ?? user.sub,
        });
        if (cancelled) return;

        if (!result.found) {
          setError(null);
          setCompany(null);
          setLoading(false);
          return;
        }

        setCompany(result);

        // Store company metadata in wizard state
        setTeam({
          teamId: result.companyUid,
          companyId: result.companyUid,
          slug: result.companySlug,
          name: result.companyName,
          joinedViaInvite: false,
          bucketName: result.bucketName,
          role: result.role,
          personUid: result.personUid,
        });

        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to look up company"
        );
        setLoading(false);
      }
    }

    detect();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Loading state
  if (loading) {
    return (
      <div className="flex flex-col items-center gap-4 max-w-sm">
        <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin" />
        <p className="text-sm text-zinc-400">
          Looking up your company…
        </p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col gap-6 max-w-sm">
        <h1 className="text-2xl font-medium text-white">Something went wrong</h1>
        <div
          role="alert"
          className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-2"
        >
          {error}
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setError(null);
            setAttempt((n) => n + 1);
          }}
          className="rounded-full py-2.5 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
        >
          Try again
        </button>
        {onSignOutAndRetry && (
          <button
            type="button"
            onClick={async () => {
              await signOut();
              onSignOutAndRetry();
            }}
            className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-4"
          >
            Sign in with a different account
          </button>
        )}
      </div>
    );
  }

  // No company found — offer two paths forward:
  //   (1) Install a personal HQ right now (no company connection needed)
  //   (2) Go do web onboarding first, then come back
  // Downstream screens read wizardState.isPersonal to skip company-scoped
  // work (S3 sync, summary labelling). Users can always add a company
  // later via `hq company add` once personal HQ is running.
  if (!company) {
    return (
      <div className="flex flex-col gap-6 max-w-sm">
        <h1 className="text-2xl font-medium text-white">
          Install personal HQ?
        </h1>
        <p className="text-sm text-zinc-400">
          We didn't find a company for this account. You can install a personal
          HQ now — it works standalone and you can add a company later.
        </p>
        <button
          type="button"
          onClick={() => {
            setIsPersonal(true);
            onNext?.();
          }}
          className="rounded-full py-2.5 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
        >
          Install personal HQ
        </button>
        <div className="flex flex-col gap-2 pt-2 border-t border-white/10">
          <p className="text-xs text-zinc-500">
            Want to set up a company first? Create one in web onboarding, then
            re-run the installer.
          </p>
          <a
            href="https://onboarding.indigo-hq.com"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full py-2.5 text-sm font-medium border border-white/20 text-white hover:bg-white/5 transition-colors text-center"
          >
            Create a company
          </a>
        </div>
      </div>
    );
  }

  // Company found — display confirmation
  return (
    <div className="flex flex-col gap-6 max-w-sm">
      <h1 className="text-2xl font-medium text-white">Your company is ready</h1>
      <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl p-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center text-green-400">
            {"\u2713"}
          </div>
          <div>
            <p className="text-sm font-medium text-white">{company.companyName}</p>
            <p className="text-xs text-zinc-500">{company.companySlug}</p>
          </div>
        </div>
        <div className="text-xs text-zinc-500 flex flex-col gap-1 mt-1">
          <span>Role: {company.role}</span>
          <span>Bucket: {company.bucketName}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onNext?.()}
        className="rounded-full py-2.5 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
      >
        Continue
      </button>
    </div>
  );
}
