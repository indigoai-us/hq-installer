// 09-personalize.tsx — US-017
// Personalization screen: single-step form.
//
// Also the de-facto "company detection" point now that the old Step 3
// (company-detect) has been removed: on mount, calls listUserCompanies(),
// seeds wizard-state.team from the first cloud company, and records the
// total count so App.tsx can conditionally skip the HQ Sync install step
// when the user has nothing to sync.
//
//  - Asks for the user's full name (prefilled from the Google idToken).
//  - Auto-lists every HQ-Cloud company the signed-in Cognito user belongs to
//    as a read-only "Connected" section. Continuous S3 reconciliation is
//    handled by the HQ-Sync menu bar app (Step 9) — not the installer.
//  - Keeps the manual "add companies" list for brand-new local companies.

import { useEffect, useState } from "react";
import { personalize } from "@/lib/personalize-writer";
import type { CompanySeed } from "@/lib/personalize-writer";
import { getCurrentUser } from "@/lib/cognito";
import {
  listUserCompanies,
  type UserCompanyEntry,
} from "@/lib/vault-handoff";
import {
  getWizardState,
  setPersonalized,
  setTeam,
  setIsPersonal,
  setConnectedCompanyCount,
  subscribeWizardState,
} from "@/lib/wizard-state";
import { slugifyCompany } from "@/lib/personalize-writer";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PersonalizeProps {
  installPath: string;
  onNext?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Strip characters that are unsafe in filesystem paths so the name can be
// used as a directory under knowledge/.
function sanitizeName(raw: string): string {
  return raw
    .trim()
    .replace(/[/\\:*?"<>|.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Personalize({ installPath, onNext }: PersonalizeProps) {
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);

  // Cloud companies the signed-in user is a member of (read-only list).
  const [cloudCompanies, setCloudCompanies] = useState<UserCompanyEntry[]>([]);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [cloudError, setCloudError] = useState<string | null>(null);

  // Companies already present at `{installPath}/companies/{slug}/company.yaml`
  // — pulled from wizard-state (detected by the directory screen when the
  // user picks a pre-existing HQ folder). Drives the "Already in this HQ"
  // read-only section and real-time dedupe on the manual-add form.
  const [existingCompanies, setExistingCompaniesState] = useState<
    Array<{ slug: string; name: string }>
  >(() => getWizardState().existingCompanies);

  // Manual (brand-new) companies the user wants scaffolded.
  const [companies, setCompanies] = useState<CompanySeed[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitStage, setSubmitStage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Stay in sync with wizard-state — the directory screen may populate
  // `existingCompanies` after this component has mounted (e.g. user
  // navigates back, picks a different folder, returns).
  useEffect(() => {
    return subscribeWizardState(() => {
      setExistingCompaniesState(getWizardState().existingCompanies);
    });
  }, []);

  const existingSlugSet = new Set(existingCompanies.map((c) => c.slug));

  // Real-time dedupe signal for the manual-add rows. A row is a duplicate
  // when its trimmed name slugifies to something already present in the
  // HQ folder (as detected by screen 06). Feeds both the per-row warning
  // and the disabled state on the "+ Add company" button.
  const hasDuplicateRow = companies.some((row) => {
    const trimmed = row.name.trim();
    if (!trimmed) return false;
    const slug = slugifyCompany(trimmed);
    return slug.length > 0 && existingSlugSet.has(slug);
  });

  // -------------------------------------------------------------------------
  // Mount: prefill name from Google idToken + list cloud companies
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function prefill() {
      try {
        const user = await getCurrentUser();
        if (cancelled) return;

        // Prefer full name from idToken; fall back to given+family, then empty.
        if (user) {
          const fromClaims =
            user.name ??
            [user.givenName, user.familyName].filter(Boolean).join(" ").trim();
          if (fromClaims && !nameTouched) {
            setName(fromClaims);
          }

          try {
            const entries = await listUserCompanies(user.tokens.accessToken);
            if (cancelled) return;
            setCloudCompanies(entries);
            // Persist company-count globally so App.tsx can skip the HQ Sync
            // menu bar install when there's nothing to sync. Also seed the
            // wizard `team` slot from the first cloud company (old Step 3's
            // job) so Summary has something to display; or flip isPersonal
            // when the user genuinely has no cloud companies.
            setConnectedCompanyCount(entries.length);
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
            } else {
              setIsPersonal(true);
            }
          } catch (err) {
            if (cancelled) return;
            setCloudError(
              err instanceof Error ? err.message : "Failed to load companies",
            );
          }
        }
      } finally {
        if (!cancelled) setCloudLoading(false);
      }
    }

    prefill();
    return () => {
      cancelled = true;
    };
    // nameTouched deliberately excluded — we only want to prefill once on
    // mount. After the user types in the field, their input wins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Manual company row helpers
  // -------------------------------------------------------------------------

  function addCompanyRow() {
    setCompanies((prev) => [...prev, { name: "", website: "" }]);
  }
  function updateCompanyRow(index: number, patch: Partial<CompanySeed>) {
    setCompanies((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }
  function removeCompanyRow(index: number) {
    setCompanies((prev) => prev.filter((_, i) => i !== index));
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  async function handleSubmit() {
    const safeName = sanitizeName(name);
    if (!safeName) {
      setErrorMsg("Please enter your name.");
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    try {
      // Merge cloud + manual companies for the writer. S3 reconciliation is
      // no longer the installer's job — the HQ-Sync menu bar app (installed
      // in Step 9) handles continuous sync post-install. We just scaffold
      // the local companies/{slug}/ directories with their yaml files here.
      const cloudSeeds: CompanySeed[] = cloudCompanies.map((c) => ({
        name: c.companyName,
        cloud: true,
        cloudCompanyUid: c.companyUid,
      }));
      const manualSeeds: CompanySeed[] = companies
        .map((c) => ({
          name: c.name.trim(),
          website: c.website?.trim() ? c.website.trim() : undefined,
        }))
        .filter((c) => c.name.length > 0);

      const merged = [...cloudSeeds, ...manualSeeds];

      setSubmitStage("Writing profile…");
      await personalize(
        {
          name: safeName,
          companies: merged.length > 0 ? merged : undefined,
          // Skip mkdir + company.yaml writes for any slug the directory
          // screen already detected on disk — preserves pre-existing
          // company data when grafting onto an existing HQ folder.
          existingSlugs: new Set(existingCompanies.map((c) => c.slug)),
        },
        installPath,
      );

      setPersonalized(true);
      onNext?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
      setSubmitStage(null);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const nameValid = sanitizeName(name).length > 0;

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-white">Personalize your HQ</h1>
        <p className="text-sm font-light text-zinc-400">
          A couple of details so HQ knows who it's working for.
        </p>
      </div>

      {/* Full name */}
      <div className="flex flex-col gap-2">
        <label htmlFor="pz-name" className="text-sm font-medium text-white">
          Full name
        </label>
        <input
          id="pz-name"
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
          placeholder="Jane Doe"
          className="bg-white/5 border border-white/10 rounded-full px-4 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
        />
      </div>

      {/* Connected cloud companies */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-white">
          Connected companies
        </label>
        <p className="text-xs text-zinc-500">
          HQ-Cloud companies linked to your account. Each gets its own folder
          under companies/ and is synced automatically.
        </p>

        {cloudLoading && (
          <p className="text-xs text-zinc-500 hq-text-shimmer">
            Loading your companies…
          </p>
        )}

        {!cloudLoading && cloudError && (
          <p className="text-xs text-red-400">
            Couldn't load cloud companies: {cloudError}
          </p>
        )}

        {!cloudLoading && !cloudError && cloudCompanies.length === 0 && (
          <p className="text-xs text-zinc-500">
            No connected companies. You can add new ones below.
          </p>
        )}

        {cloudCompanies.length > 0 && (
          <div className="flex flex-col gap-2">
            {cloudCompanies.map((co) => (
              <div
                key={co.companyUid}
                className="flex items-center justify-between gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-2"
              >
                <div className="flex flex-col">
                  <span className="text-sm text-white">{co.companyName}</span>
                  <span className="text-xs text-zinc-500">
                    {co.companySlug} · {co.role}
                  </span>
                </div>
                <span className="text-xs text-green-400 px-2 py-0.5 rounded-full bg-green-400/10 border border-green-400/20">
                  Connected
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Already in this HQ — read-only list of companies the directory
          screen detected at `{installPath}/companies/`. Hidden when the
          array is empty. Shares visual DNA with the "Connected companies"
          block above. */}
      {existingCompanies.length > 0 && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-white">
            Already in this HQ
          </label>
          <p className="text-xs text-zinc-500">
            Companies detected in the folder you picked. These are preserved
            as-is — we won't overwrite their settings.
          </p>
          <div className="flex flex-col gap-2">
            {existingCompanies.map((co) => (
              <div
                key={co.slug}
                className="flex items-center justify-between gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-2"
              >
                <div className="flex flex-col">
                  <span className="text-sm text-white">{co.name}</span>
                  <span className="text-xs text-zinc-500">{co.slug}</span>
                </div>
                <span className="text-xs text-zinc-400 px-2 py-0.5 rounded-full bg-white/5 border border-white/10">
                  Existing
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manual companies */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-white">
          Additional companies{" "}
          <span className="text-zinc-500 font-normal">(optional)</span>
        </label>
        <p className="text-xs text-zinc-500">
          Brand-new companies to scaffold locally. Website is optional.
        </p>

        {companies.length > 0 && (
          <div className="flex flex-col gap-2">
            {companies.map((row, i) => {
              const trimmedName = row.name.trim();
              const rowSlug = trimmedName ? slugifyCompany(trimmedName) : "";
              const isDuplicate =
                rowSlug.length > 0 && existingSlugSet.has(rowSlug);
              return (
                <div key={i} className="flex flex-col gap-1">
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      aria-label={`Company ${i + 1} name`}
                      placeholder="Company name"
                      value={row.name}
                      onChange={(e) =>
                        updateCompanyRow(i, { name: e.target.value })
                      }
                      className="flex-1 bg-white/5 border border-white/10 rounded-full px-4 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
                    />
                    <input
                      type="url"
                      aria-label={`Company ${i + 1} website`}
                      placeholder="https://example.com"
                      value={row.website ?? ""}
                      onChange={(e) =>
                        updateCompanyRow(i, { website: e.target.value })
                      }
                      className="flex-1 bg-white/5 border border-white/10 rounded-full px-4 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
                    />
                    <button
                      type="button"
                      aria-label={`Remove company ${i + 1}`}
                      onClick={() => removeCompanyRow(i)}
                      className="w-8 h-8 rounded-full text-zinc-500 hover:text-white hover:bg-white/10 transition-colors flex items-center justify-center text-lg"
                    >
                      ×
                    </button>
                  </div>
                  {isDuplicate && (
                    <p
                      role="status"
                      className="text-xs text-amber-400 px-2"
                    >
                      Already in this HQ — will be synced
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={addCompanyRow}
          disabled={hasDuplicateRow}
          className="self-start text-xs text-zinc-400 hover:text-white transition-colors px-3 py-1.5 rounded-full border border-white/10 hover:border-white/25 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-400 disabled:hover:border-white/10"
        >
          + Add company
        </button>
      </div>

      {/* Error */}
      {errorMsg && (
        <div
          role="alert"
          className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-2"
        >
          {errorMsg}
        </div>
      )}

      {/* Submit */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || !nameValid}
          className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? "Setting up…" : "Continue"}
        </button>
        {submitting && submitStage && (
          <span className="text-xs text-zinc-400 hq-text-shimmer">
            {submitStage}
          </span>
        )}
      </div>
    </div>
  );
}
