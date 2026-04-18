// CustomizationForm.tsx — US-017
// Step 3 of personalization: optional customizations + submit

interface CustomizationFormProps {
  customizations: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  errorMsg: string | null;
}

export function CustomizationForm({
  customizations,
  onChange,
  onSubmit,
  submitting,
  errorMsg,
}: CustomizationFormProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 bg-white/5 border border-white/10 rounded-xl px-4 py-4">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Customizations (optional)
        </p>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">Preferred communication style</span>
            <input
              type="text"
              value={customizations["communicationStyle"] ?? ""}
              onChange={(e) => onChange("communicationStyle", e.target.value)}
              placeholder="e.g. concise, detailed, formal"
              aria-label="Preferred communication style"
              className="bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-white/30"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">Primary domain</span>
            <input
              type="text"
              value={customizations["primaryDomain"] ?? ""}
              onChange={(e) => onChange("primaryDomain", e.target.value)}
              placeholder="e.g. engineering, marketing, finance"
              aria-label="Primary domain"
              className="bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-white/30"
            />
          </label>
        </div>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="flex items-start gap-2 bg-red-950/40 border border-red-500/20 rounded-xl px-4 py-3"
        >
          <p className="text-sm text-red-400">{errorMsg}</p>
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving…" : "Submit"}
        </button>
      </div>
    </div>
  );
}
