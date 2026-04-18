// 09-personalize.tsx — US-017
// Personalization screen: multi-step form (identity → starter project → customization)

import { useState } from "react";
import { personalize } from "../lib/personalize-writer";
import type {
  CompanySeed,
  PersonalizationAnswers,
} from "../lib/personalize-writer";
import { setPersonalized } from "../lib/wizard-state";
import { IdentityForm } from "../components/forms/IdentityForm";
import { StarterProjectPicker } from "../components/forms/StarterProjectPicker";
import { CustomizationForm } from "../components/forms/CustomizationForm";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PersonalizeProps {
  installPath: string;
  onNext?: () => void;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Personalize({ installPath, onNext }: PersonalizeProps) {
  const [step, setStep] = useState<Step>(1);

  // Step 1 — Identity
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [goals, setGoals] = useState("");
  // Optional list of companies the user wants HQ to scaffold under companies/.
  // Stored as a parallel array (not in IdentityForm) so we can keep the form
  // component reusable. Each row is fully optional — empty rows are dropped on
  // submit so users can leave the section blank.
  const [companies, setCompanies] = useState<CompanySeed[]>([]);

  // Step 2 — Starter project
  const [starterProject, setStarterProject] =
    useState<PersonalizationAnswers["starterProject"] | null>(null);

  // Step 3 — Customizations + submit state
  const [customizations, setCustomizations] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const step1Valid =
    name.trim().length > 0 && about.trim().length > 0 && goals.trim().length > 0;
  const step2Valid = starterProject !== null;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleIdentityChange(field: "name" | "about" | "goals", value: string) {
    if (field === "name") setName(value);
    else if (field === "about") setAbout(value);
    else setGoals(value);
  }

  function handleCustomizationChange(key: string, value: string) {
    setCustomizations((prev) => ({ ...prev, [key]: value }));
  }

  // --- Companies list helpers (Step 1, optional section) ---
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

  // Strip characters that are unsafe in filesystem paths so the name can be
  // used as a directory under knowledge/. Replaces sequences of unsafe chars
  // with a single space and collapses internal whitespace.
  function sanitizeName(raw: string): string {
    return raw
      .trim()
      .replace(/[/\\:*?"<>|.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function handleSubmit() {
    if (!starterProject) return;

    const safeName = sanitizeName(name);
    if (!safeName) {
      setErrorMsg("Name contains only unsafe characters. Please enter a valid name.");
      return;
    }

    // Drop empty/whitespace-only company rows and normalize website blanks
    // back to undefined so the writer doesn't emit empty `website:` lines.
    const cleanedCompanies: CompanySeed[] = companies
      .map((c) => ({
        name: c.name.trim(),
        website: c.website?.trim() ? c.website.trim() : undefined,
      }))
      .filter((c) => c.name.length > 0);

    const answers: PersonalizationAnswers = {
      name: safeName,
      about: about.trim(),
      goals: goals.trim(),
      starterProject,
      customizations: Object.keys(customizations).length > 0 ? customizations : undefined,
      companies: cleanedCompanies.length > 0 ? cleanedCompanies : undefined,
    };

    setSubmitting(true);
    setErrorMsg(null);

    try {
      await personalize(answers, installPath);
      // Flip the wizard-state marker so the global Next button unlocks.
      // Done before onNext() so the router's canGoNext recomputation on the
      // next step renders with the up-to-date value if the user back-navigates.
      setPersonalized(true);
      onNext?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Step labels
  // ---------------------------------------------------------------------------

  const stepLabels = ["Identity", "Starter project", "Customization"];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Personalize your HQ</h1>
        <p className="text-sm font-light text-zinc-400">
          Tell us a bit about yourself so we can tailor HQ to your needs.
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex gap-2">
        {stepLabels.map((label, i) => {
          const stepNum = (i + 1) as Step;
          const isActive = step === stepNum;
          const isDone = step > stepNum;
          return (
            <div
              key={label}
              className={`flex items-center gap-1.5 text-xs font-medium ${
                isActive
                  ? "text-white"
                  : isDone
                  ? "text-zinc-400"
                  : "text-zinc-600"
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                  isActive
                    ? "bg-white text-black"
                    : isDone
                    ? "bg-white/20 text-zinc-300"
                    : "bg-white/5 text-zinc-600"
                }`}
              >
                {stepNum}
              </span>
              {label}
              {i < stepLabels.length - 1 && (
                <span className="text-zinc-700 ml-1">›</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Step 1: Identity */}
      {step === 1 && (
        <>
          <IdentityForm
            name={name}
            about={about}
            goals={goals}
            onChange={handleIdentityChange}
          />

          {/* Optional companies list — scaffolds companies/{slug}/ for each row */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-white">
                Companies <span className="text-zinc-500 font-normal">(optional)</span>
              </label>
              <p className="text-xs text-zinc-500">
                List companies you want HQ to scaffold. Website is optional.
              </p>
            </div>

            {companies.length > 0 && (
              <div className="flex flex-col gap-2">
                {companies.map((row, i) => (
                  <div key={i} className="flex gap-2 items-center">
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
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={addCompanyRow}
              className="self-start text-xs text-zinc-400 hover:text-white transition-colors px-3 py-1.5 rounded-full border border-white/10 hover:border-white/25"
            >
              + Add company
            </button>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep(2)}
              disabled={!step1Valid}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </>
      )}

      {/* Step 2: Starter project */}
      {step === 2 && (
        <>
          <StarterProjectPicker
            selected={starterProject}
            onChange={setStarterProject}
          />
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-white/10 text-zinc-300 hover:bg-white/20 transition-colors"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              disabled={!step2Valid}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </>
      )}

      {/* Step 3: Customization + submit */}
      {step === 3 && (
        <>
          <CustomizationForm
            customizations={customizations}
            onChange={handleCustomizationChange}
            onSubmit={handleSubmit}
            submitting={submitting}
            errorMsg={errorMsg}
          />
        </>
      )}
    </div>
  );
}
