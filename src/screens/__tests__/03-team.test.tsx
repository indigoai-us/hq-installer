import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamSetup } from "../03-team.js";

// ---------------------------------------------------------------------------
// TeamSetup screen tests (US-014)
//
// Contract target: hq-ops /api/installer/register-company (Cognito-authed).
// Request:  { cognito_sub, company_slug, company_name, plan_tier }
// Response: { team_id, company_id, created_at }
//
// "Join team" mode has been removed until /api/installer/join-team exists.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks — must be declared before any component imports
// ---------------------------------------------------------------------------
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// wizard-state mock — isolate the screen from real in-memory state
// ---------------------------------------------------------------------------
vi.mock("../../lib/wizard-state.js", () => ({
  getWizardState: vi.fn(() => ({ telemetryEnabled: true, team: null })),
  setTeam: vi.fn(),
  setTelemetryEnabled: vi.fn(),
  clearWizardState: vi.fn(),
}));

import * as wizardState from "../../lib/wizard-state.js";

const mockSetTeam = vi.mocked(wizardState.setTeam);

// ---------------------------------------------------------------------------
// cognito mock — stub getCurrentUser so 03-team can read a fake JWT + sub
// without touching the real Tauri keychain.
//
// `vi.hoisted` lifts these constants to the top of the file alongside the
// hoisted `vi.mock` call, so both see the same values. Declaring them as
// plain `const` triggers a temporal-dead-zone error because vi.mock is
// hoisted above them.
// ---------------------------------------------------------------------------
const { MOCK_SUB, MOCK_ID_TOKEN } = vi.hoisted(() => ({
  MOCK_SUB: "a4487468-f0a1-706e-8a26-ae7eaf2cb4f9",
  MOCK_ID_TOKEN: "mock-id-token",
}));

vi.mock("../../lib/cognito.js", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({
    sub: MOCK_SUB,
    email: "stefan@getindigo.ai",
    tokens: {
      accessToken: "mock-access-token",
      idToken: MOCK_ID_TOKEN,
      refreshToken: "mock-refresh-token",
      expiresAt: Date.now() + 3600_000,
    },
  }),
}));

// ---------------------------------------------------------------------------
// fetch mock — mirrors the hq-ops register-company contract
// ---------------------------------------------------------------------------

const MOCK_REGISTER_RESPONSE = {
  team_id: "8014674a-5a79-416a-98e4-db4829485791",
  company_id: "639c65b8-591d-4b75-8d11-107b6648af6f",
  created_at: "2026-04-15T19:45:35.291Z",
};

function mockFetchSuccess(payload: object) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  } as Response);
}

function mockFetchFailure(status = 500, body = { error: "Internal Server Error" }) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response);
}

// ---------------------------------------------------------------------------

describe("TeamSetup screen (03-team.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSuccess(MOCK_REGISTER_RESPONSE);
  });

  // -------------------------------------------------------------------------
  describe("Create team form", () => {
    it("renders the create-team heading", () => {
      render(<TeamSetup onNext={vi.fn()} />);
      expect(screen.getByRole("heading", { name: /create.*team/i })).toBeDefined();
    });

    it("renders a team name input field", () => {
      render(<TeamSetup onNext={vi.fn()} />);
      const nameField =
        screen.queryByLabelText(/team name/i) ||
        screen.queryByLabelText(/name/i) ||
        screen.queryByPlaceholderText(/team name/i) ||
        screen.queryByPlaceholderText(/name/i);
      expect(nameField).not.toBeNull();
    });

    it("renders a team slug input field", () => {
      render(<TeamSetup onNext={vi.fn()} />);
      const slugField =
        screen.queryByLabelText(/slug/i) ||
        screen.queryByPlaceholderText(/slug/i) ||
        screen.queryByLabelText(/identifier/i);
      expect(slugField).not.toBeNull();
    });

    it("renders a submit button", () => {
      render(<TeamSetup onNext={vi.fn()} />);
      const submitBtn = screen.queryByRole("button", { name: /^create team$/i });
      expect(submitBtn).not.toBeNull();
    });

    it("does NOT render a 'Join team' mode selector", () => {
      render(<TeamSetup onNext={vi.fn()} />);
      // Only the Create team submit button should match /create/; no separate
      // join tab or form should exist.
      expect(screen.queryByRole("tab", { name: /join/i })).toBeNull();
      expect(screen.queryByLabelText(/invite/i)).toBeNull();
      expect(screen.queryByPlaceholderText(/invite/i)).toBeNull();
    });

    it("POSTs to register-company with the Cognito contract shape on submit", async () => {
      const user = userEvent.setup();
      mockFetchSuccess(MOCK_REGISTER_RESPONSE);
      render(<TeamSetup onNext={vi.fn()} />);

      const nameField =
        screen.queryByLabelText(/team name/i) ||
        screen.queryByLabelText(/name/i) ||
        screen.queryByPlaceholderText(/team name/i) ||
        screen.queryByPlaceholderText(/name/i);
      const slugField =
        screen.queryByLabelText(/slug/i) ||
        screen.queryByPlaceholderText(/slug/i) ||
        screen.queryByLabelText(/identifier/i);

      expect(nameField).not.toBeNull();
      expect(slugField).not.toBeNull();

      await user.type(nameField!, "Acme Corp");
      // Slug auto-fills from the name; user clears + retypes to override.
      await user.clear(slugField!);
      await user.type(slugField!, "acme");

      const submitBtn = screen.queryByRole("button", { name: /^create team$/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });

      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/api/installer/register-company");
      expect((options as RequestInit).method?.toUpperCase()).toBe("POST");

      // Body: new snake_case Cognito contract
      const body = JSON.parse((options as RequestInit).body as string);
      expect(body.cognito_sub).toBe(MOCK_SUB);
      expect(body.company_slug).toBe("acme");
      expect(body.company_name).toBe("Acme Corp");
      expect(body.plan_tier).toBe("free");

      // Authorization header carries the idToken from getCurrentUser()
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${MOCK_ID_TOKEN}`);
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("reassembles TeamMetadata from API response + local form state after success", async () => {
      const user = userEvent.setup();
      mockFetchSuccess(MOCK_REGISTER_RESPONSE);
      render(<TeamSetup onNext={vi.fn()} />);

      const nameField =
        screen.queryByLabelText(/team name/i) ||
        screen.queryByPlaceholderText(/team name/i);
      const slugField =
        screen.queryByLabelText(/slug/i) ||
        screen.queryByPlaceholderText(/slug/i);

      await user.type(nameField!, "Acme Corp");
      await user.clear(slugField!);
      await user.type(slugField!, "acme");

      const submitBtn = screen.queryByRole("button", { name: /^create team$/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        expect(mockSetTeam).toHaveBeenCalledTimes(1);
      });

      const arg = mockSetTeam.mock.calls[0][0];
      // IDs come from the API response (snake_case → camelCase)
      expect(arg.teamId).toBe(MOCK_REGISTER_RESPONSE.team_id);
      expect(arg.companyId).toBe(MOCK_REGISTER_RESPONSE.company_id);
      // slug + name come from local form state (API doesn't echo them back)
      expect(arg.slug).toBe("acme");
      expect(arg.name).toBe("Acme Corp");
      // joinedViaInvite is hardcoded false for the create-only flow
      expect(arg.joinedViaInvite).toBe(false);
    });

    it("calls onNext() after successful team creation", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      mockFetchSuccess(MOCK_REGISTER_RESPONSE);
      render(<TeamSetup onNext={onNext} />);

      const nameField =
        screen.queryByLabelText(/team name/i) ||
        screen.queryByPlaceholderText(/team name/i);
      const slugField =
        screen.queryByLabelText(/slug/i) ||
        screen.queryByPlaceholderText(/slug/i);

      await user.type(nameField!, "Acme Corp");
      await user.clear(slugField!);
      await user.type(slugField!, "acme");

      const submitBtn = screen.queryByRole("button", { name: /^create team$/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    });

    it("calls setTeam() before onNext() on successful create", async () => {
      const user = userEvent.setup();
      const callOrder: string[] = [];
      mockSetTeam.mockImplementationOnce(() => {
        callOrder.push("setTeam");
      });
      const onNext = vi.fn(() => {
        callOrder.push("onNext");
      });
      mockFetchSuccess(MOCK_REGISTER_RESPONSE);
      render(<TeamSetup onNext={onNext} />);

      const nameField =
        screen.queryByLabelText(/team name/i) ||
        screen.queryByPlaceholderText(/team name/i);
      const slugField =
        screen.queryByLabelText(/slug/i) ||
        screen.queryByPlaceholderText(/slug/i);

      await user.type(nameField!, "Acme Corp");
      await user.clear(slugField!);
      await user.type(slugField!, "acme");

      const submitBtn = screen.queryByRole("button", { name: /^create team$/i });
      await user.click(submitBtn!);

      await waitFor(() => expect(onNext).toHaveBeenCalled());
      expect(callOrder).toEqual(["setTeam", "onNext"]);
    });

    it("renders an error message when the API call fails", async () => {
      const user = userEvent.setup();
      mockFetchFailure(500);
      render(<TeamSetup onNext={vi.fn()} />);

      const nameField =
        screen.queryByLabelText(/team name/i) ||
        screen.queryByPlaceholderText(/team name/i);
      const slugField =
        screen.queryByLabelText(/slug/i) ||
        screen.queryByPlaceholderText(/slug/i);

      await user.type(nameField!, "Bad Corp");
      await user.clear(slugField!);
      await user.type(slugField!, "bad");

      const submitBtn = screen.queryByRole("button", { name: /^create team$/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        const alert = screen.queryByRole("alert");
        const errorText = screen.queryByText(/error|failed|unable|problem/i);
        expect(alert || errorText).not.toBeNull();
      });
    });

    it("does NOT call onNext() when the API call fails", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      mockFetchFailure(500);
      render(<TeamSetup onNext={onNext} />);

      const nameField =
        screen.queryByLabelText(/team name/i) ||
        screen.queryByPlaceholderText(/team name/i);
      const slugField =
        screen.queryByLabelText(/slug/i) ||
        screen.queryByPlaceholderText(/slug/i);

      await user.type(nameField!, "Bad Corp");
      await user.clear(slugField!);
      await user.type(slugField!, "bad");

      const submitBtn = screen.queryByRole("button", { name: /^create team$/i });
      await user.click(submitBtn!);

      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      expect(onNext).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("UI policy — no-purple-monochrome-ui", () => {
    it("does NOT use 'purple' class names in the DOM", () => {
      const { container } = render(<TeamSetup onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("does NOT use 'indigo' class names in the DOM", () => {
      const { container } = render(<TeamSetup onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bindigo\b/);
    });
  });

  // -------------------------------------------------------------------------
  describe("Tauri environment compatibility", () => {
    it("renders cleanly when Tauri APIs are mocked", () => {
      expect(() => {
        render(<TeamSetup onNext={vi.fn()} />);
      }).not.toThrow();
    });

    it("does NOT call onNext on initial render", () => {
      const onNext = vi.fn();
      render(<TeamSetup onNext={onNext} />);
      expect(onNext).not.toHaveBeenCalled();
    });
  });
});
