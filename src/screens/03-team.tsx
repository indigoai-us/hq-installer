// 03-team.tsx — US-014
// Team create screen.
//
// NOTE: The "Join team" mode is temporarily hidden — the hq-ops
// /api/installer/join-team endpoint does not exist yet. For the first end-to-end
// integration we only support creating a new company. Invite/join will land in
// a follow-up US.

import React, { useState } from "react";
import { setTeam } from "@/lib/wizard-state";
import { getCurrentUser } from "@/lib/cognito";

interface TeamSetupProps {
  onNext?: () => void;
}

function getApiBase(): string {
  const base = (import.meta.env.VITE_API_BASE_URL as string) || "";
  if (!base && import.meta.env.PROD) {
    console.warn("[hq-installer] VITE_API_BASE_URL is not set — team API requests will fail");
  }
  return base;
}

/** "Indigo Test" → "indigo-test" */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function TeamSetup({ onNext }: TeamSetupProps) {
  const [teamName, setTeamName] = useState("");
  const [teamSlug, setTeamSlug] = useState("");
  // Tracks whether the user has manually edited the slug; once true, we stop
  // auto-syncing it from teamName.
  const [slugDirty, setSlugDirty] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Pull the Cognito IdToken + caller's sub from the keychain. Screen 02
      // (sign-in) runs before this one, so a session should always exist; the
      // null-check is defensive in case the user manually clears tokens.
      const user = await getCurrentUser();
      if (!user) {
        throw new Error("No active session — please sign in again");
      }

      const res = await fetch(`${getApiBase()}/api/installer/register-company`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.tokens.idToken}`,
        },
        body: JSON.stringify({
          cognito_sub: user.sub,
          company_slug: teamSlug,
          company_name: teamName,
          // Plan selection UI lives downstream in hq-ops billing — first-run
          // installer always creates a `free`-tier company.
          plan_tier: "free",
        }),
      });

      if (!res.ok) {
        throw new Error(`Failed to create team (${res.status})`);
      }

      // hq-ops returns { team_id, company_id, created_at }. The wizard-state
      // TeamMetadata type wants a richer shape, so we reassemble it by mixing
      // API-returned IDs with the local form values.
      const data = (await res.json()) as {
        team_id: string;
        company_id: string;
        created_at: string;
      };

      setTeam({
        teamId: data.team_id,
        companyId: data.company_id,
        slug: teamSlug,
        name: teamName,
        joinedViaInvite: false,
      });
      onNext?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create team");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-sm">
      <h1 className="text-2xl font-medium text-white">Create your team</h1>

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-2"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleCreate} className="flex flex-col gap-4">
        <input
          type="text"
          aria-label="Team name"
          placeholder="Team name"
          value={teamName}
          onChange={(e) => {
            const v = e.target.value;
            setTeamName(v);
            if (!slugDirty) setTeamSlug(slugify(v));
          }}
          required
          className="bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
        />
        <input
          type="text"
          aria-label="Slug"
          placeholder="slug"
          value={teamSlug}
          onChange={(e) => {
            setTeamSlug(slugify(e.target.value));
            setSlugDirty(true);
          }}
          required
          className="bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-full py-2.5 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-50"
        >
          {loading ? "Creating…" : "Create team"}
        </button>
      </form>

      {/* Escape hatch — advance the wizard without creating a team. Downstream
          screens tolerate missing team state. */}
      <button
        type="button"
        onClick={() => onNext?.()}
        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors self-center"
      >
        Skip for now
      </button>
    </div>
  );
}
