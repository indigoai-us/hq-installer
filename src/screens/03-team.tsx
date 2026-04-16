// 03-team.tsx — US-004
// Company detection screen. Looks up the user's existing company from
// vault-service instead of creating a new one. Users provision their company
// during web onboarding — the installer just needs to find and confirm it.

import { useState, useEffect, useRef } from "react";
import { setTeam } from "@/lib/wizard-state";
import { getCurrentUser } from "@/lib/cognito";
import { resolveUserCompany } from "@/lib/vault-handoff";

interface CompanyDetectProps {
  onNext?: () => void;
}

export function TeamSetup({ onNext }: CompanyDetectProps) {
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
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    async function detect() {
      try {
        const user = await getCurrentUser();
        if (!user) {
          setError("No active session — please sign in again.");
          setLoading(false);
          return;
        }

        const result = await resolveUserCompany(user.tokens.accessToken);

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
        });

        setLoading(false);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to look up company"
        );
        setLoading(false);
      }
    }

    detect();
  }, []);

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
            attemptedRef.current = false;
            setLoading(true);
            setError(null);
          }}
          className="rounded-full py-2.5 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  // No company found — user hasn't completed web onboarding
  if (!company) {
    return (
      <div className="flex flex-col gap-6 max-w-sm">
        <h1 className="text-2xl font-medium text-white">
          No company found
        </h1>
        <p className="text-sm text-zinc-400">
          Complete web onboarding first to provision your company, then return
          here.
        </p>
        <a
          href="https://onboarding.indigo-hq.com"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-full py-2.5 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors text-center"
        >
          Go to web onboarding
        </a>
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
