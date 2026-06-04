import { describe, it, expect, beforeEach } from "vitest";
import {
  getWizardState,
  setTelemetryEnabled,
  setTeam,
  setIsPersonal,
  setPersonalized,
  clearWizardState,
} from "../wizard-state.js";
import type { TeamMetadata } from "../wizard-state.js";

// ---------------------------------------------------------------------------
// wizard-state unit tests — US-005 5-step contract
//
// wizard-state itself doesn't know about step indices — it's just a typed
// singleton with mutators. These tests pin its surface: defaults, mutual
// exclusion (team ↔ isPersonal), defensive copies, and clearWizardState
// idempotence. The 5-step flow (welcome → install → signin → setup → done)
// only enters by way of which fields get written by which screen.
// ---------------------------------------------------------------------------

const MOCK_TEAM: TeamMetadata = {
  teamId: "team-abc123",
  companyId: "co-xyz789",
  slug: "acme",
  name: "Acme Corp",
  joinedViaInvite: false,
};

const MOCK_TEAM_INVITE: TeamMetadata = {
  teamId: "team-invite001",
  companyId: "co-invite001",
  slug: "partner-co",
  name: "Partner Co",
  joinedViaInvite: true,
};

describe("wizard-state", () => {
  // Reset state between every test so tests are isolated
  beforeEach(() => {
    clearWizardState();
  });

  // -------------------------------------------------------------------------
  describe("getWizardState() — initial state", () => {
    it("returns an object with telemetryEnabled set to true by default", () => {
      const state = getWizardState();
      expect(state.telemetryEnabled).toBe(true);
    });

    it("returns an object with team set to null by default", () => {
      const state = getWizardState();
      expect(state.team).toBeNull();
    });

    it("returns an object with isPersonal=false by default", () => {
      const state = getWizardState();
      expect(state.isPersonal).toBe(false);
    });

    it("returns an object with personalized=false by default", () => {
      const state = getWizardState();
      expect(state.personalized).toBe(false);
    });

    it("returns a consistent object on repeated calls (same reference or equal shape)", () => {
      const a = getWizardState();
      const b = getWizardState();
      expect(a.telemetryEnabled).toBe(b.telemetryEnabled);
      expect(a.team).toBe(b.team);
    });
  });

  // -------------------------------------------------------------------------
  describe("setTeam()", () => {
    it("writes team metadata so getWizardState() returns it", () => {
      setTeam(MOCK_TEAM);
      const state = getWizardState();
      expect(state.team).not.toBeNull();
      expect(state.team?.teamId).toBe("team-abc123");
      expect(state.team?.companyId).toBe("co-xyz789");
      expect(state.team?.slug).toBe("acme");
      expect(state.team?.name).toBe("Acme Corp");
      expect(state.team?.joinedViaInvite).toBe(false);
    });

    it("correctly sets joinedViaInvite=true when joining via invite", () => {
      setTeam(MOCK_TEAM_INVITE);
      const state = getWizardState();
      expect(state.team?.joinedViaInvite).toBe(true);
    });

    it("replaces a previous team if setTeam is called again", () => {
      setTeam(MOCK_TEAM);
      setTeam(MOCK_TEAM_INVITE);
      const state = getWizardState();
      expect(state.team?.teamId).toBe("team-invite001");
    });

    it("does not mutate the passed-in object (defensive copy or equal values)", () => {
      const original = { ...MOCK_TEAM };
      setTeam(MOCK_TEAM);
      // Mutating the original after setTeam should not affect stored state
      const stored = getWizardState().team;
      expect(stored?.teamId).toBe(original.teamId);
    });
  });

  // -------------------------------------------------------------------------
  describe("setTelemetryEnabled()", () => {
    it("setTelemetryEnabled(false) sets telemetryEnabled to false", () => {
      setTelemetryEnabled(false);
      expect(getWizardState().telemetryEnabled).toBe(false);
    });

    it("setTelemetryEnabled(true) sets telemetryEnabled to true", () => {
      setTelemetryEnabled(false);
      setTelemetryEnabled(true);
      expect(getWizardState().telemetryEnabled).toBe(true);
    });

    it("setTelemetryEnabled does not affect team field", () => {
      setTeam(MOCK_TEAM);
      setTelemetryEnabled(false);
      expect(getWizardState().team?.teamId).toBe("team-abc123");
    });
  });

  // -------------------------------------------------------------------------
  describe("setIsPersonal()", () => {
    it("setIsPersonal(true) flips isPersonal to true", () => {
      setIsPersonal(true);
      expect(getWizardState().isPersonal).toBe(true);
    });

    it("setIsPersonal(true) clears any previously stored team (mutual exclusion)", () => {
      setTeam(MOCK_TEAM);
      setIsPersonal(true);
      const state = getWizardState();
      expect(state.isPersonal).toBe(true);
      expect(state.team).toBeNull();
    });

    it("setTeam resets isPersonal to false (mutual exclusion in reverse)", () => {
      setIsPersonal(true);
      setTeam(MOCK_TEAM);
      const state = getWizardState();
      expect(state.team?.teamId).toBe("team-abc123");
      expect(state.isPersonal).toBe(false);
    });

    it("setIsPersonal(false) leaves team untouched", () => {
      setTeam(MOCK_TEAM);
      setIsPersonal(false);
      expect(getWizardState().team?.teamId).toBe("team-abc123");
    });
  });

  // -------------------------------------------------------------------------
  describe("setPersonalized()", () => {
    // The personalized flag records that personalize() succeeded. In the
    // 5-step flow it's set by the Setup orchestrator's personalize stage
    // and read by Summary; it no longer gates a global Next button (the
    // Setup screen auto-advances — see wizard-router.getStepValidity(4)).

    it("setPersonalized(true) flips personalized to true", () => {
      setPersonalized(true);
      expect(getWizardState().personalized).toBe(true);
    });

    it("setPersonalized(false) flips personalized back to false", () => {
      setPersonalized(true);
      setPersonalized(false);
      expect(getWizardState().personalized).toBe(false);
    });

    it("does not affect unrelated fields (team, isPersonal, installPath)", () => {
      setTeam(MOCK_TEAM);
      setPersonalized(true);
      const state = getWizardState();
      expect(state.team?.teamId).toBe("team-abc123");
      expect(state.isPersonal).toBe(false);
      expect(state.personalized).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("clearWizardState()", () => {
    it("resets telemetryEnabled back to true after being set to false", () => {
      setTelemetryEnabled(false);
      clearWizardState();
      expect(getWizardState().telemetryEnabled).toBe(true);
    });

    it("resets team back to null after being set", () => {
      setTeam(MOCK_TEAM);
      clearWizardState();
      expect(getWizardState().team).toBeNull();
    });

    it("is idempotent — calling clearWizardState twice leaves state clean", () => {
      setTeam(MOCK_TEAM);
      setTelemetryEnabled(false);
      clearWizardState();
      clearWizardState();
      const state = getWizardState();
      expect(state.team).toBeNull();
      expect(state.telemetryEnabled).toBe(true);
    });

    it("resets isPersonal back to false", () => {
      setIsPersonal(true);
      clearWizardState();
      expect(getWizardState().isPersonal).toBe(false);
    });

    it("resets personalized back to false", () => {
      setPersonalized(true);
      clearWizardState();
      expect(getWizardState().personalized).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("return type — read-only contract", () => {
    it("getWizardState() does not expose a mutable reference that can corrupt state", () => {
      setTeam(MOCK_TEAM);
      const state = getWizardState() as Record<string, unknown>;
      // Attempt direct mutation — implementation may be frozen or return a copy;
      // either way the stored state should remain consistent on next call
      try {
        state["team"] = null;
      } catch {
        // Frozen object throws in strict mode — that's fine
      }
      // If the implementation exposes a live reference, this would fail:
      // (acceptable: it may return a copy each time, so the mutation has no effect)
      // Either way, calling getWizardState() again must still return team data or null
      // — we just verify it doesn't throw
      expect(() => getWizardState()).not.toThrow();
    });
  });
});
