// StarterProjectPicker.tsx — US-017
// Step 2 of personalization: choose a starter project

import type { PersonalizationAnswers } from "../../lib/personalize-writer";

type StarterProject = PersonalizationAnswers["starterProject"];

interface ProjectOption {
  slug: StarterProject;
  label: string;
  description: string;
}

const PROJECT_OPTIONS: ProjectOption[] = [
  {
    slug: "personal-assistant",
    label: "Personal Assistant",
    description: "An AI assistant tailored to your personal workflow and tasks.",
  },
  {
    slug: "social-media",
    label: "Social Media",
    description: "Tools for managing and growing your social media presence.",
  },
  {
    slug: "code-worker",
    label: "Code Worker",
    description: "A developer-focused setup for coding and engineering tasks.",
  },
];

interface StarterProjectPickerProps {
  selected: StarterProject | null;
  onChange: (slug: StarterProject) => void;
}

export function StarterProjectPicker({ selected, onChange }: StarterProjectPickerProps) {
  return (
    <div className="flex flex-col gap-4 bg-white/5 border border-white/10 rounded-xl px-4 py-4">
      <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
        Choose a starter project
      </p>

      <div className="flex flex-col gap-3">
        {PROJECT_OPTIONS.map((opt) => {
          const isSelected = selected === opt.slug;
          return (
            <label
              key={opt.slug}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                isSelected
                  ? "border-white/30 bg-white/10"
                  : "border-white/10 bg-black/20 hover:bg-white/5"
              }`}
            >
              <input
                type="radio"
                name="starterProject"
                value={opt.slug}
                checked={isSelected}
                onChange={() => onChange(opt.slug)}
                aria-label={opt.label}
                className="mt-0.5 accent-white"
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-zinc-200">{opt.label}</span>
                <span className="text-xs text-zinc-500">{opt.description}</span>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
