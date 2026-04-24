// wizard-state.ts — US-014
// In-memory singleton for wizard session data.

export interface TeamMetadata {
  teamId: string;
  companyId: string;
  slug: string;
  name: string;
  joinedViaInvite: boolean;
  bucketName?: string;
  role?: string;
  personUid?: string;
}

export interface WizardState {
  telemetryEnabled: boolean;
  team: TeamMetadata | null;
  /** True when the user opted into a personal HQ (no company connection).
   *  When set, the Summary screen shows "Personal HQ" instead of team info,
   *  and the HQ Sync menu bar install step is skipped (no bucket to sync). */
  isPersonal: boolean;
  installPath: string | null;
  gitName: string | null;
  gitEmail: string | null;
  /** True once Personalize has successfully written profile.md, voice-style.md,
   *  the starter project, and any user-supplied companies. Gates the global
   *  Next button so users can't bypass the screen. */
  personalized: boolean;
  /** Count of HQ-Cloud companies detected at Personalize time. Drives the
   *  conditional skip of the HQ Sync menu bar install: if 0, the app has
   *  nothing to sync, so there's no value in installing it right now. */
  connectedCompanyCount: number;
  /** How the installer should behave when grafting onto a pre-existing HQ
   *  folder. `'graft'` dedupes against existing companies + preserves them;
   *  `'overwrite'` proceeds as a full install (legacy behaviour). `null`
   *  when the picked folder is not an existing HQ, or before the user
   *  has chosen a mode. Set by the directory screen (06). */
  hqMode: "graft" | "overwrite" | null;
  /** Companies already present at `{installPath}/companies/{slug}/company.yaml`
   *  when the directory screen detected an existing HQ. Used by downstream
   *  steps (Personalize writer, sync flows) to dedupe — don't clobber an
   *  existing company.yaml. Empty when no existing HQ. */
  existingCompanies: Array<{ slug: string; name: string }>;
}

const state: WizardState = {
  telemetryEnabled: true,
  team: null,
  isPersonal: false,
  installPath: null,
  gitName: null,
  gitEmail: null,
  personalized: false,
  connectedCompanyCount: 0,
  hqMode: null,
  existingCompanies: [],
};

// ---------------------------------------------------------------------------
// Pub/sub — needed so React components can re-render when singleton mutates
// without each setter having to thread a callback all the way down. Used by
// App.tsx to refresh the WizardShell's `canGoNext` button when a screen
// updates state mid-step (e.g. picking an install directory in screen 06).
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Subscribe to any wizard-state mutation. Returns an unsubscribe fn. */
export function subscribeWizardState(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Return a frozen snapshot of the current wizard state. */
export function getWizardState(): Readonly<WizardState> {
  return Object.freeze({
    ...state,
    team: state.team ? { ...state.team } : null,
    existingCompanies: state.existingCompanies.map((c) => ({ ...c })),
  });
}

export function setTelemetryEnabled(enabled: boolean): void {
  state.telemetryEnabled = enabled;
  notify();
}

/** Store team metadata returned by the API. */
export function setTeam(team: TeamMetadata): void {
  state.team = { ...team };
  state.isPersonal = false;
  notify();
}

/** Opt into personal-HQ mode (no company connection).
 *  Mutually exclusive with a team — clears any existing team. */
export function setIsPersonal(value: boolean): void {
  state.isPersonal = value;
  if (value) state.team = null;
  notify();
}

/** Store the chosen install path. */
export function setInstallPath(path: string): void {
  state.installPath = path;
  notify();
}

/** Store the git user identity for the initial commit. */
export function setGitIdentity(name: string, email: string): void {
  state.gitName = name;
  state.gitEmail = email;
  notify();
}

/** Mark Screen 07 (Personalize) as successfully completed. Read by
 *  getStepValidity(7, …) to unlock the global Next button. */
export function setPersonalized(value: boolean): void {
  state.personalized = value;
  notify();
}

/** Record how many HQ-Cloud companies the user has connected. Set by
 *  Personalize when it resolves the cloud-companies list; read by App.tsx
 *  to decide whether to auto-skip the HQ Sync menu bar install step. */
export function setConnectedCompanyCount(count: number): void {
  state.connectedCompanyCount = count;
  notify();
}

/** Store how the installer should treat a pre-existing HQ folder. Pass
 *  `null` to clear (e.g. user switched to a fresh folder). */
export function setHqMode(mode: "graft" | "overwrite" | null): void {
  state.hqMode = mode;
  notify();
}

/** Record companies detected at the picked folder. Empty array clears. */
export function setExistingCompanies(
  companies: Array<{ slug: string; name: string }>,
): void {
  state.existingCompanies = companies.map((c) => ({ slug: c.slug, name: c.name }));
  notify();
}

/** Reset all wizard state to initial defaults. */
export function clearWizardState(): void {
  state.telemetryEnabled = true;
  state.team = null;
  state.isPersonal = false;
  state.installPath = null;
  state.gitName = null;
  state.gitEmail = null;
  state.personalized = false;
  state.connectedCompanyCount = 0;
  state.hqMode = null;
  state.existingCompanies = [];
  notify();
}
