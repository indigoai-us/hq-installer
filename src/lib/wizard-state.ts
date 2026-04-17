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
   *  When set, screens like 08b-sync self-skip because there's no bucket to
   *  pull from, and 11-summary shows "Personal HQ" instead of em-dashes. */
  isPersonal: boolean;
  installPath: string | null;
  gitName: string | null;
  gitEmail: string | null;
}

const state: WizardState = {
  telemetryEnabled: true,
  team: null,
  isPersonal: false,
  installPath: null,
  gitName: null,
  gitEmail: null,
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
  return Object.freeze({ ...state, team: state.team ? { ...state.team } : null });
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

/** Reset all wizard state to initial defaults. */
export function clearWizardState(): void {
  state.telemetryEnabled = true;
  state.team = null;
  state.isPersonal = false;
  state.installPath = null;
  state.gitName = null;
  state.gitEmail = null;
  notify();
}
