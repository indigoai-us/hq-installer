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
}

const state: WizardState = {
  telemetryEnabled: true,
  team: null,
};

/** Return a frozen snapshot of the current wizard state. */
export function getWizardState(): Readonly<WizardState> {
  return Object.freeze({ ...state, team: state.team ? { ...state.team } : null });
}

export function setTelemetryEnabled(enabled: boolean): void {
  state.telemetryEnabled = enabled;
}

/** Store team metadata returned by the API. */
export function setTeam(team: TeamMetadata): void {
  state.team = { ...team };
}

/** Reset all wizard state to initial defaults. */
export function clearWizardState(): void {
  state.telemetryEnabled = true;
  state.team = null;
}
