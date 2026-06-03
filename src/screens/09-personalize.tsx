// 09-personalize.tsx — US-003
// Silent personalization step: runs automatically on mount from the Google
// idToken — no name form, no company-add UI. Cloud company auto-detection
// still runs and seeds wizard-state.team / isPersonal.

import { useEffect, useState } from "react";
import { personalize } from "@/lib/personalize-writer";
import type { CompanySeed } from "@/lib/personalize-writer";
import { getCurrentUser } from "@/lib/cognito";
import { listUserCompanies } from "@/lib/vault-handoff";
import { setPersonalized, setTeam, setIsPersonal } from "@/lib/wizard-state";
import {
  getInstallerVersion,
  recordStepStart,
  recordStepOk,
  recordStepFailure,
} from "@/lib/install-manifest";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PersonalizeProps {
  installPath: string;
  onNext?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Personalize({ installPath, onNext }: PersonalizeProps) {
  const [stage, setStage] = useState<string>("Setting up your profile…");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const user = await getCurrentUser();
        if (cancelled) return;

        // Derive full name from the Google idToken; fall back to given+family.
        const name = user
          ? (user.name ??
              [user.givenName, user.familyName].filter(Boolean).join(" ").trim())
          : "";

        // Detect cloud companies and seed wizard state.
        const companies: CompanySeed[] = [];
        if (user) {
          try {
            const entries = await listUserCompanies(user.tokens.accessToken);
            if (cancelled) return;
            if (entries.length > 0) {
              const first = entries[0];
              setTeam({
                teamId: first.companyUid,
                companyId: first.companyUid,
                slug: first.companySlug,
                name: first.companyName,
                joinedViaInvite: false,
                bucketName: first.bucketName,
                role: first.role,
              });
              for (const c of entries) {
                companies.push({
                  name: c.companyName,
                  cloud: true,
                  cloudCompanyUid: c.companyUid,
                });
              }
            } else {
              setIsPersonal(true);
            }
          } catch {
            // Non-fatal: company detection failure does not block install.
          }
        }

        const ver = await getInstallerVersion();
        await recordStepStart(installPath, ver, "personalize").catch(() => {});

        setStage("Writing profile…");
        await personalize(
          { name, companies: companies.length > 0 ? companies : undefined },
          installPath,
        );

        if (cancelled) return;
        await recordStepOk(installPath, ver, "personalize").catch(() => {});
        setPersonalized(true);
        onNext?.();
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        const ver = await getInstallerVersion().catch(() => "unknown");
        await recordStepFailure(
          installPath,
          ver,
          "personalize",
          msg || "unknown error",
        ).catch(() => {});
        setErrorMsg(msg || "Something went wrong. Please try again.");
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // Intentionally no deps — this is a one-shot mount effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (errorMsg) {
    return (
      <div className="flex flex-col gap-6 max-w-lg">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-medium text-white">Setup failed</h1>
          <p className="text-sm font-light text-zinc-400">
            Personalization could not complete.
          </p>
        </div>
        <div
          role="alert"
          className="text-sm text-zinc-400 bg-white/5 border border-white/10 rounded-xl px-4 py-2"
        >
          {errorMsg}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-white">
          Personalizing your HQ
        </h1>
        <p className="text-sm font-light text-zinc-400">{stage}</p>
      </div>
      <div className="flex items-center gap-3">
        <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
        <span className="text-sm text-zinc-400 hq-text-shimmer">{stage}</span>
      </div>
    </div>
  );
}
