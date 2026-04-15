// 03-team.tsx — US-014
// Team create/join screen.

import React, { useState } from "react";
import { setTeam } from "@/lib/wizard-state";

interface TeamSetupProps {
  onNext?: () => void;
}

type Mode = "create" | "join";

function getApiBase(): string {
  const base = (import.meta.env.VITE_API_BASE_URL as string) || "";
  if (!base && import.meta.env.PROD) {
    console.warn("[hq-installer] VITE_API_BASE_URL is not set — team API requests will fail");
  }
  return base;
}

export function TeamSetup({ onNext }: TeamSetupProps) {
  const [mode, setMode] = useState<Mode>("create");

  // Create mode state
  const [teamName, setTeamName] = useState("");
  const [teamSlug, setTeamSlug] = useState("");

  // Join mode state
  const [inviteCode, setInviteCode] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${getApiBase()}/api/installer/register-company`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: teamName, slug: teamSlug }),
      });
      if (!res.ok) {
        throw new Error(`Failed to create team (${res.status})`);
      }
      const data = await res.json() as {
        teamId: string;
        companyId: string;
        slug: string;
        name: string;
        joinedViaInvite: boolean;
      };
      setTeam(data);
      onNext?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create team");
    } finally {
      setLoading(false);
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${getApiBase()}/api/installer/join-team`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteCode }),
      });
      if (!res.ok) {
        throw new Error(`Failed to join team (${res.status})`);
      }
      const data = await res.json() as {
        teamId: string;
        companyId: string;
        slug: string;
        name: string;
        joinedViaInvite: boolean;
      };
      setTeam(data);
      onNext?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to join team");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-sm">
      <h1 className="text-2xl font-medium text-white">Set up your team</h1>

      {/* Mode tabs */}
      <div className="flex gap-1 bg-white/5 border border-white/10 rounded-full p-1">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "create"}
          onClick={() => {
            setMode("create");
            setError(null);
          }}
          className={`flex-1 py-1.5 rounded-full text-sm font-medium transition-colors ${
            mode === "create"
              ? "bg-white text-black"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          Create team
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "join"}
          onClick={() => {
            setMode("join");
            setError(null);
          }}
          className={`flex-1 py-1.5 rounded-full text-sm font-medium transition-colors ${
            mode === "join"
              ? "bg-white text-black"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          Join team
        </button>
      </div>

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-2"
        >
          {error}
        </div>
      )}

      {/* Create mode */}
      {mode === "create" && (
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <input
            type="text"
            aria-label="Team name"
            placeholder="Team name"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            required
            className="bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
          />
          <input
            type="text"
            aria-label="Slug"
            placeholder="slug"
            value={teamSlug}
            onChange={(e) => setTeamSlug(e.target.value)}
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
      )}

      {/* Join mode */}
      {mode === "join" && (
        <form onSubmit={handleJoin} className="flex flex-col gap-4">
          <input
            type="text"
            aria-label="Invite code"
            placeholder="Invite code"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            required
            className="bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-full py-2.5 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-50"
          >
            {loading ? "Joining…" : "Join team"}
          </button>
        </form>
      )}
    </div>
  );
}
