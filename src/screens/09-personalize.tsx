// 09-personalize.tsx — US-017
// Personalization screen: multi-step form (identity → starter project → customization)

import { useState } from "react";
import { personalize } from "../lib/personalize-writer";
import type { PersonalizationAnswers } from "../lib/personalize-writer";
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

    const answers: PersonalizationAnswers = {
      name: safeName,
      about: about.trim(),
      goals: goals.trim(),
      starterProject,
      customizations: Object.keys(customizations).length > 0 ? customizations : undefined,
    };

    setSubmitting(true);
    setErrorMsg(null);

    try {
      await personalize(answers, installPath);
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
