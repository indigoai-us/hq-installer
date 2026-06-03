import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Personalize } from "../09-personalize.js";

// ---------------------------------------------------------------------------
// 09-personalize.tsx tests — US-003 (silent personalization)
//
// The screen runs personalize() automatically on mount from the Google idToken.
// No name form, no Continue button, no user interaction required.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockResolvedValue(""),
  readDir: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tauri-apps/api/path", () => ({
  resolveResource: vi.fn(async (p: string) => `/resolved/${p}`),
}));

// ---------------------------------------------------------------------------
// Dependency mocks
// ---------------------------------------------------------------------------

vi.mock("../../lib/personalize-writer.js", () => ({
  personalize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/cognito.js", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({
    sub: "sub-123",
    email: "jane@example.com",
    name: "Jane Doe",
    givenName: "Jane",
    familyName: "Doe",
    tokens: {
      accessToken: "at",
      idToken: "it",
      refreshToken: "rt",
      expiresAt: Date.now() + 60_000,
    },
  }),
}));

vi.mock("../../lib/vault-handoff.js", () => ({
  listUserCompanies: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/wizard-state.js", () => ({
  getWizardState: vi.fn(() => ({
    telemetryEnabled: true,
    team: null,
    isPersonal: true,
    installPath: "/tmp/hq",
    gitName: null,
    gitEmail: null,
    personalized: false,
  })),
  setPersonalized: vi.fn(),
  setTeam: vi.fn(),
  setIsPersonal: vi.fn(),
}));

vi.mock("../../lib/install-manifest.js", () => ({
  getInstallerVersion: vi.fn().mockResolvedValue("1.0.0"),
  recordStepStart: vi.fn().mockResolvedValue(undefined),
  recordStepOk: vi.fn().mockResolvedValue(undefined),
  recordStepFailure: vi.fn().mockResolvedValue(undefined),
}));

import { personalize } from "../../lib/personalize-writer.js";
import { getCurrentUser } from "../../lib/cognito.js";
import { listUserCompanies } from "../../lib/vault-handoff.js";
import {
  setPersonalized,
  setTeam,
  setIsPersonal,
} from "../../lib/wizard-state.js";

const mockPersonalize = vi.mocked(personalize);
const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockListUserCompanies = vi.mocked(listUserCompanies);
const mockSetPersonalized = vi.mocked(setPersonalized);
const mockSetTeam = vi.mocked(setTeam);
const mockSetIsPersonal = vi.mocked(setIsPersonal);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Personalize screen (09-personalize.tsx) — US-003 silent personalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPersonalize.mockResolvedValue(undefined);
    mockGetCurrentUser.mockResolvedValue({
      sub: "sub-123",
      email: "jane@example.com",
      name: "Jane Doe",
      givenName: "Jane",
      familyName: "Doe",
      tokens: {
        accessToken: "at",
        idToken: "it",
        refreshToken: "rt",
        expiresAt: Date.now() + 60_000,
      },
    });
    mockListUserCompanies.mockResolvedValue([]);
  });

  // ── 1. Silent auto-run (no interaction required) ──────────────────────────

  describe("silent auto-run", () => {
    it("renders without throwing", () => {
      expect(() => {
        render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      }).not.toThrow();
    });

    it("does NOT render a name input", () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      const inputs = document.querySelectorAll("input");
      expect(inputs.length).toBe(0);
    });

    it("does NOT render a Continue or Submit button", () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("calls personalize() automatically on mount without user interaction", async () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => expect(mockPersonalize).toHaveBeenCalledTimes(1));
    });

    it("calls onNext() automatically after personalize() succeeds", async () => {
      const onNext = vi.fn();
      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    });

    it("sets personalized=true in wizard-state after success", async () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() =>
        expect(mockSetPersonalized).toHaveBeenCalledWith(true),
      );
    });
  });

  // ── 2. Name derivation from Google idToken ────────────────────────────────

  describe("name derivation from idToken", () => {
    it("passes the `name` claim to personalize() when present", async () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => expect(mockPersonalize).toHaveBeenCalledTimes(1));
      const [answers] = mockPersonalize.mock.calls[0];
      expect(answers.name).toBe("Jane Doe");
    });

    it("falls back to given+family name when `name` claim is absent", async () => {
      mockGetCurrentUser.mockResolvedValueOnce({
        sub: "sub-456",
        email: "taylor@example.com",
        givenName: "Taylor",
        familyName: "Smith",
        tokens: {
          accessToken: "at",
          idToken: "it",
          refreshToken: "rt",
          expiresAt: Date.now() + 60_000,
        },
      });

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => expect(mockPersonalize).toHaveBeenCalledTimes(1));
      const [answers] = mockPersonalize.mock.calls[0];
      expect(answers.name).toBe("Taylor Smith");
    });

    it("passes empty string when no user is signed in", async () => {
      mockGetCurrentUser.mockResolvedValueOnce(null);
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => expect(mockPersonalize).toHaveBeenCalledTimes(1));
      const [answers] = mockPersonalize.mock.calls[0];
      expect(answers.name).toBe("");
    });

    it("passes installPath as baseDir to personalize()", async () => {
      render(
        <Personalize installPath="/custom/install/path" onNext={vi.fn()} />,
      );
      await waitFor(() => expect(mockPersonalize).toHaveBeenCalledTimes(1));
      const [, baseDir] = mockPersonalize.mock.calls[0];
      expect(baseDir).toBe("/custom/install/path");
    });
  });

  // ── 3. Cloud company auto-detection ──────────────────────────────────────

  describe("cloud company auto-detection", () => {
    it("calls listUserCompanies with the access token on mount", async () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() =>
        expect(mockListUserCompanies).toHaveBeenCalledWith("at"),
      );
    });

    it("seeds wizard `team` from the first cloud company", async () => {
      mockListUserCompanies.mockResolvedValueOnce([
        {
          companyUid: "uid-acme",
          companySlug: "acme",
          companyName: "Acme Corp",
          bucketName: "hq-vault-acme",
          role: "admin",
          status: "active",
        },
      ]);

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() => expect(mockSetTeam).toHaveBeenCalledTimes(1));
      expect(mockSetTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: "uid-acme",
          companyId: "uid-acme",
          slug: "acme",
          name: "Acme Corp",
          joinedViaInvite: false,
          bucketName: "hq-vault-acme",
          role: "admin",
        }),
      );
    });

    it("flips isPersonal=true when the user has no cloud companies", async () => {
      mockListUserCompanies.mockResolvedValueOnce([]);
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() =>
        expect(mockSetIsPersonal).toHaveBeenCalledWith(true),
      );
      expect(mockSetTeam).not.toHaveBeenCalled();
    });

    it("passes cloud companies to personalize() payload", async () => {
      mockListUserCompanies.mockResolvedValueOnce([
        {
          companyUid: "uid-acme",
          companySlug: "acme",
          companyName: "Acme Corp",
          bucketName: "hq-vault-acme",
          role: "admin",
          status: "active",
        },
      ]);

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() => expect(mockPersonalize).toHaveBeenCalledTimes(1));
      const [answers] = mockPersonalize.mock.calls[0];
      expect(answers.companies).toEqual([
        expect.objectContaining({
          name: "Acme Corp",
          cloud: true,
          cloudCompanyUid: "uid-acme",
        }),
      ]);
    });

    it("does not block progress when listUserCompanies throws", async () => {
      mockListUserCompanies.mockRejectedValueOnce(new Error("network error"));
      const onNext = vi.fn();
      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    });
  });

  // ── 4. Error state ────────────────────────────────────────────────────────

  describe("error state", () => {
    it("shows an error UI when personalize() rejects", async () => {
      mockPersonalize.mockRejectedValueOnce(new Error("Disk write failed"));
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => {
        expect(screen.queryByRole("alert")).not.toBeNull();
      });
    });

    it("does NOT call onNext() when personalize() rejects", async () => {
      const onNext = vi.fn();
      mockPersonalize.mockRejectedValueOnce(new Error("Disk write failed"));
      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeNull(),
      );
      expect(onNext).not.toHaveBeenCalled();
    });

    it("surfaces the error message text in the UI", async () => {
      mockPersonalize.mockRejectedValueOnce(
        new Error("Permission denied: /tmp/hq"),
      );
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => {
        expect(document.body.textContent).toMatch(/permission denied/i);
      });
    });
  });

  // ── 5. UI policy — no-purple-monochrome-ui ────────────────────────────────

  describe("UI policy — no-purple-monochrome-ui", () => {
    it("does NOT use 'purple' class names in the DOM", () => {
      const { container } = render(
        <Personalize installPath="/tmp/hq" onNext={vi.fn()} />,
      );
      expect(container.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("does NOT use 'indigo' class names in the DOM", () => {
      const { container } = render(
        <Personalize installPath="/tmp/hq" onNext={vi.fn()} />,
      );
      expect(container.innerHTML).not.toMatch(/\bindigo\b/);
    });
  });
});
