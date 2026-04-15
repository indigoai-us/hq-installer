// IdentityForm.tsx — US-017
// Step 1 of personalization: name, about, goals

interface IdentityFormProps {
  name: string;
  about: string;
  goals: string;
  onChange: (field: "name" | "about" | "goals", value: string) => void;
}

export function IdentityForm({ name, about, goals, onChange }: IdentityFormProps) {
  return (
    <div className="flex flex-col gap-4 bg-white/5 border border-white/10 rounded-xl px-4 py-4">
      <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
        About you
      </p>

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-400">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => onChange("name", e.target.value)}
            placeholder="Your full name"
            aria-label="Name"
            className="bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-white/30"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-400">About</span>
          <textarea
            value={about}
            onChange={(e) => onChange("about", e.target.value)}
            placeholder="Tell us about yourself"
            aria-label="About"
            rows={3}
            className="bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-white/30 resize-none"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-400">Goals</span>
          <textarea
            value={goals}
            onChange={(e) => onChange("goals", e.target.value)}
            placeholder="What are your goals?"
            aria-label="Goals"
            rows={3}
            className="bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-white/30 resize-none"
          />
        </label>
      </div>
    </div>
  );
}
