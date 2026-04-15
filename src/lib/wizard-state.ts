// wizard-state.ts — US-014
// In-memory singleton for wizard session data.

export interface TeamMetadata {
  teamId: string;
  companyId: string;
  slug: string;
  name: string;
  joinedViaInvite: boolean;
}

export interface WizardState {
  telemetryEnabled: boolean;
  team: TeamMetadata | null;
  installPath: string | null;
  gitName: string | null;
  gitEmail: string | null;
}

const state: WizardState = {
  telemetryEnabled: true,
  team: null,
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
  state.installPath = null;
  state.gitName = null;
  state.gitEmail = null;
  notify();
}
