import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Personalize } from "../09-personalize.js";

// ---------------------------------------------------------------------------
// Personalize screen tests (US-017, redesigned 2026-04-18, S3 sync removed
// 2026-04-22)
//
// Screen: single-step form
//   - Full-name input prefilled from the Google idToken (via getCurrentUser)
//   - Read-only list of HQ-Cloud companies the user is a member of. On mount
//     the screen persists `connectedCompanyCount` (for App.tsx HQ Sync skip),
//     seeds `team` from the first company, or flips `isPersonal` if empty.
//   - Optional manual companies list (free-text rows the user adds)
//   - Single "Continue" button: calls personalize() with merged company seeds,
//     then onNext(). S3 reconciliation is no longer the installer's job — the
//     HQ-Sync menu bar app (Step 9) owns continuous sync post-install.
//
// The earlier 3-step form (Identity / StarterProject / Customization) was
// replaced; tests here cover the new surface.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks — must be declared before component imports
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
// Dependency mocks — isolate screen from fs, keychain, vault, and S3.
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
    connectedCompanyCount: 0,
  })),
  setPersonalized: vi.fn(),
  setTeam: vi.fn(),
  setIsPersonal: vi.fn(),
  setConnectedCompanyCount: vi.fn(),
}));

import { personalize } from "../../lib/personalize-writer.js";
import { getCurrentUser } from "../../lib/cognito.js";
import { listUserCompanies } from "../../lib/vault-handoff.js";
import {
  getWizardState,
  setPersonalized,
  setTeam,
  setIsPersonal,
  setConnectedCompanyCount,
} from "../../lib/wizard-state.js";

const mockPersonalize = vi.mocked(personalize);
const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockListUserCompanies = vi.mocked(listUserCompanies);
const mockGetWizardState = vi.mocked(getWizardState);
const mockSetPersonalized = vi.mocked(setPersonalized);
const mockSetTeam = vi.mocked(setTeam);
const mockSetIsPersonal = vi.mocked(setIsPersonal);
const mockSetConnectedCompanyCount = vi.mocked(setConnectedCompanyCount);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findContinueButton() {
  return (
    screen.queryByRole("button", { name: /^continue$/i }) ||
    screen.queryByRole("button", { name: /setting up/i })
  );
}

function findNameInput(): HTMLInputElement | null {
  return (
    (screen.queryByLabelText(/full name/i) as HTMLInputElement | null) ||
    (screen.queryByPlaceholderText(/jane doe/i) as HTMLInputElement | null)
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Personalize screen (09-personalize.tsx) — redesigned single-step form", () => {
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
    mockGetWizardState.mockReturnValue({
      telemetryEnabled: true,
      team: null,
      isPersonal: true,
      installPath: "/tmp/hq",
      gitName: null,
      gitEmail: null,
      personalized: false,
      connectedCompanyCount: 0,
    });
  });

  // ── 1. Initial render ─────────────────────────────────────────────────────

  describe("initial render", () => {
    it("renders without throwing when Tauri APIs are mocked", () => {
      expect(() => {
        render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      }).not.toThrow();
    });

    it("renders a name input", () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      expect(findNameInput()).not.toBeNull();
    });

    it("does NOT call personalize() on mount", () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      expect(mockPersonalize).not.toHaveBeenCalled();
    });

    it("does NOT call onNext() on mount", () => {
      const onNext = vi.fn();
      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);
      expect(onNext).not.toHaveBeenCalled();
    });

    it("fetches the current user on mount", async () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => expect(mockGetCurrentUser).toHaveBeenCalled());
    });
  });

  // ── 2. Name prefill from Google idToken ───────────────────────────────────

  describe("name prefill", () => {
    it("prefills the name field from the idToken `name` claim", async () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() => {
        const input = findNameInput();
        expect(input?.value).toBe("Jane Doe");
      });
    });

    it("falls back to given+family name when `name` is absent", async () => {
      mockGetCurrentUser.mockResolvedValueOnce({
        sub: "sub-123",
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

      await waitFor(() => {
        const input = findNameInput();
        expect(input?.value).toBe("Taylor Smith");
      });
    });

    it("leaves the name field blank when no user is signed in", async () => {
      mockGetCurrentUser.mockResolvedValueOnce(null);

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      // Give the effect a tick to run.
      await waitFor(() => expect(mockGetCurrentUser).toHaveBeenCalled());
      const input = findNameInput();
      expect(input?.value).toBe("");
    });
  });

  // ── 3. Cloud companies list ───────────────────────────────────────────────

  describe("cloud companies", () => {
    it("calls listUserCompanies with the access token on mount", async () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() =>
        expect(mockListUserCompanies).toHaveBeenCalledWith("at"),
      );
    });

    it("renders each cloud company returned by the vault", async () => {
      mockListUserCompanies.mockResolvedValueOnce([
        {
          companyUid: "uid-acme",
          companySlug: "acme",
          companyName: "Acme Corp",
          bucketName: "hq-vault-acme",
          role: "admin",
          status: "active",
        },
        {
          companyUid: "uid-initech",
          companySlug: "initech",
          companyName: "Initech",
          bucketName: "hq-vault-initech",
          role: "member",
          status: "active",
        },
      ]);

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Acme Corp")).toBeDefined();
        expect(screen.getByText("Initech")).toBeDefined();
      });
    });

    it("shows a friendly empty-state message when the user has no cloud companies", async () => {
      mockListUserCompanies.mockResolvedValueOnce([]);

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() => {
        expect(
          screen.queryByText(/no connected companies/i),
        ).not.toBeNull();
      });
    });
  });

  // ── 4. Continue button — validation + submit path ─────────────────────────

  describe("Continue button", () => {
    it("is disabled while the name field is empty", async () => {
      mockGetCurrentUser.mockResolvedValueOnce(null); // no prefill
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() => expect(mockGetCurrentUser).toHaveBeenCalled());

      const btn = findContinueButton() as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(true);

      // Clicking a disabled button must not submit.
      if (btn) await user.click(btn);
      expect(mockPersonalize).not.toHaveBeenCalled();
    });

    it("becomes enabled once the name field has text", async () => {
      mockGetCurrentUser.mockResolvedValueOnce(null);
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() => expect(mockGetCurrentUser).toHaveBeenCalled());

      const input = findNameInput();
      if (input) await user.type(input, "Jane Doe");

      await waitFor(() => {
        const btn = findContinueButton() as HTMLButtonElement | null;
        expect(btn?.disabled).toBe(false);
      });
    });

    it("clicking Continue calls personalize() with the entered name", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      // Wait for prefill before clicking.
      await waitFor(() => {
        const input = findNameInput();
        expect(input?.value).toBe("Jane Doe");
      });

      await user.click(findContinueButton()!);

      await waitFor(() => expect(mockPersonalize).toHaveBeenCalledTimes(1));
      const [answers] = mockPersonalize.mock.calls[0];
      expect(answers.name).toBe("Jane Doe");
    });

    it("passes installPath through as baseDir to personalize()", async () => {
      const user = userEvent.setup();
      render(
        <Personalize installPath="/custom/install/path" onNext={vi.fn()} />,
      );

      await waitFor(() => {
        const input = findNameInput();
        expect(input?.value).toBe("Jane Doe");
      });

      await user.click(findContinueButton()!);

      await waitFor(() => expect(mockPersonalize).toHaveBeenCalledTimes(1));
      const [, baseDir] = mockPersonalize.mock.calls[0];
      expect(baseDir).toBe("/custom/install/path");
    });

    it("calls onNext() and flips the personalized flag after success", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);

      await waitFor(() => {
        const input = findNameInput();
        expect(input?.value).toBe("Jane Doe");
      });

      await user.click(findContinueButton()!);

      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
      expect(mockSetPersonalized).toHaveBeenCalledWith(true);
    });

    it("does NOT omit starterProject — it isn't required anymore", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() => {
        const input = findNameInput();
        expect(input?.value).toBe("Jane Doe");
      });

      await user.click(findContinueButton()!);

      await waitFor(() => expect(mockPersonalize).toHaveBeenCalledTimes(1));
      const [answers] = mockPersonalize.mock.calls[0];
      expect(answers.starterProject).toBeUndefined();
    });
  });

  // ── 5. Wizard-state seeding on mount ──────────────────────────────────────
  //
  // The installer no longer performs S3 reconciliation directly — the
  // HQ-Sync menu bar app (Step 9) owns continuous sync. But Personalize is
  // still the de-facto "company detection" point (old Step 3 was removed),
  // so on mount it must:
  //   • Call setConnectedCompanyCount(entries.length) so App.tsx can skip
  //     the HQ Sync install step when the user has no cloud companies.
  //   • setTeam() from the first cloud company, or setIsPersonal(true)
  //     when the user has none.

  describe("wizard-state seeding on mount", () => {
    it("persists the cloud-company count (0) when the user has none", async () => {
      mockListUserCompanies.mockResolvedValueOnce([]);

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() =>
        expect(mockSetConnectedCompanyCount).toHaveBeenCalledWith(0),
      );
    });

    it("persists the cloud-company count when the user has multiple", async () => {
      mockListUserCompanies.mockResolvedValueOnce([
        {
          companyUid: "uid-acme",
          companySlug: "acme",
          companyName: "Acme Corp",
          bucketName: "hq-vault-acme",
          role: "admin",
          status: "active",
        },
        {
          companyUid: "uid-initech",
          companySlug: "initech",
          companyName: "Initech",
          bucketName: "hq-vault-initech",
          role: "member",
          status: "active",
        },
      ]);

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() =>
        expect(mockSetConnectedCompanyCount).toHaveBeenCalledWith(2),
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

      await waitFor(() => expect(mockSetIsPersonal).toHaveBeenCalledWith(true));
      // And no team should have been set — nothing to seed from.
      expect(mockSetTeam).not.toHaveBeenCalled();
    });

    it("tags cloud companies on the personalize() payload", async () => {
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

      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Acme Corp")).toBeDefined();
      });

      await user.click(findContinueButton()!);

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
  });

  // ── 6. Error state — personalize() rejects ────────────────────────────────

  describe("error state", () => {
    it("shows an error message when personalize() rejects", async () => {
      const user = userEvent.setup();
      mockPersonalize.mockRejectedValueOnce(new Error("Disk write failed"));

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() => {
        const input = findNameInput();
        expect(input?.value).toBe("Jane Doe");
      });

      await user.click(findContinueButton()!);

      await waitFor(() => {
        const alert = screen.queryByRole("alert");
        expect(alert).not.toBeNull();
      });
    });

    it("does NOT call onNext() when personalize() rejects", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      mockPersonalize.mockRejectedValueOnce(new Error("Disk write failed"));

      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);

      await waitFor(() => {
        const input = findNameInput();
        expect(input?.value).toBe("Jane Doe");
      });

      await user.click(findContinueButton()!);

      await waitFor(() => {
        expect(screen.queryByRole("alert")).not.toBeNull();
      });

      expect(onNext).not.toHaveBeenCalled();
    });

    it("surfaces the error message text in the UI", async () => {
      const user = userEvent.setup();
      mockPersonalize.mockRejectedValueOnce(
        new Error("Permission denied: /tmp/hq"),
      );

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await waitFor(() => {
        const input = findNameInput();
        expect(input?.value).toBe("Jane Doe");
      });

      await user.click(findContinueButton()!);

      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toMatch(/permission denied/i);
      });
    });
  });

  // ── 7. UI policy — no-purple-monochrome-ui ────────────────────────────────

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

  // ── 8. Tauri environment compatibility ────────────────────────────────────

  describe("Tauri environment compatibility", () => {
    it("renders cleanly when Tauri APIs are mocked", () => {
      expect(() => {
        render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      }).not.toThrow();
    });

    it("does NOT call onNext on initial render", () => {
      const onNext = vi.fn();
      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);
      expect(onNext).not.toHaveBeenCalled();
    });
  });
});
