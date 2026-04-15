import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamSetup } from "../03-team.js";

// ---------------------------------------------------------------------------
// TeamSetup screen tests (US-014)
//
// These tests are written BEFORE the implementation exists.
// They will fail until src/screens/03-team.tsx is created.
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
// fetch mock
// ---------------------------------------------------------------------------

const MOCK_REGISTER_RESPONSE = {
  teamId: "team-new001",
  companyId: "co-new001",
  slug: "acme",
  name: "Acme Corp",
  joinedViaInvite: false,
};

const MOCK_JOIN_RESPONSE = {
  teamId: "team-join001",
  companyId: "co-join001",
  slug: "partner",
  name: "Partner Inc",
  joinedViaInvite: true,
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
    // Default: fetch succeeds
    mockFetchSuccess(MOCK_REGISTER_RESPONSE);
  });

  // -------------------------------------------------------------------------
  describe("mode toggle — Create vs Join", () => {
    it("renders a 'Create team' mode selector (tab, button, or link)", () => {
      render(<TeamSetup onNext={vi.fn()} />);
      const createSelector =
        screen.queryByRole("tab", { name: /create/i }) ||
        screen.queryByRole("button", { name: /create/i }) ||
        screen.queryByText(/create.*team/i);
      expect(createSelector).not.toBeNull();
    });

    it("renders a 'Join team' mode selector (tab, button, or link)", () => {
      render(<TeamSetup onNext={vi.fn()} />);
      const joinSelector =
        screen.queryByRole("tab", { name: /join/i }) ||
        screen.queryByRole("button", { name: /join/i }) ||
        screen.queryByText(/join.*team/i);
      expect(joinSelector).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("Create team mode", () => {
    // Create mode should be the default on mount

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

    it("renders a submit button in create mode", () => {
      render(<TeamSetup onNext={vi.fn()} />);
      const submitBtn =
        screen.queryByRole("button", { name: /create/i }) ||
        screen.queryByRole("button", { name: /submit/i }) ||
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /continue/i });
      expect(submitBtn).not.toBeNull();
    });

    it("POSTs to register-company endpoint with name and slug on create submit", async () => {
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

      const submitBtn =
        screen.queryByRole("button", { name: /create/i }) ||
        screen.queryByRole("button", { name: /submit/i }) ||
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /continue/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(url).toContain("/api/installer/register-company");
        const body = JSON.parse((options as RequestInit).body as string);
        expect(body.name).toBe("Acme Corp");
        expect(body.slug).toBe("acme");
        expect((options as RequestInit).method?.toUpperCase()).toBe("POST");
      });
    });

    it("calls setTeam() with the API response data after successful create", async () => {
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

      await user.type(nameField!, "Acme Corp");
      // Slug auto-fills from the name; user clears + retypes to override.
      await user.clear(slugField!);
      await user.type(slugField!, "acme");

      const submitBtn =
        screen.queryByRole("button", { name: /create/i }) ||
        screen.queryByRole("button", { name: /submit/i }) ||
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /continue/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        expect(mockSetTeam).toHaveBeenCalledTimes(1);
        const arg = mockSetTeam.mock.calls[0][0];
        expect(arg.teamId).toBe(MOCK_REGISTER_RESPONSE.teamId);
        expect(arg.companyId).toBe(MOCK_REGISTER_RESPONSE.companyId);
        expect(arg.slug).toBe(MOCK_REGISTER_RESPONSE.slug);
      });
    });

    it("calls onNext() after successful team creation", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      mockFetchSuccess(MOCK_REGISTER_RESPONSE);
      render(<TeamSetup onNext={onNext} />);

      const nameField =
        screen.queryByLabelText(/team name/i) ||
        screen.queryByLabelText(/name/i) ||
        screen.queryByPlaceholderText(/team name/i) ||
        screen.queryByPlaceholderText(/name/i);
      const slugField =
        screen.queryByLabelText(/slug/i) ||
        screen.queryByPlaceholderText(/slug/i) ||
        screen.queryByLabelText(/identifier/i);

      await user.type(nameField!, "Acme Corp");
      // Slug auto-fills from the name; user clears + retypes to override.
      await user.clear(slugField!);
      await user.type(slugField!, "acme");

      const submitBtn =
        screen.queryByRole("button", { name: /create/i }) ||
        screen.queryByRole("button", { name: /submit/i }) ||
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /continue/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    });

    it("calls setTeam() before onNext() on successful create", async () => {
      const user = userEvent.setup();
      const callOrder: string[] = [];
      mockSetTeam.mockImplementationOnce(() => { callOrder.push("setTeam"); });
      const onNext = vi.fn(() => { callOrder.push("onNext"); });
      mockFetchSuccess(MOCK_REGISTER_RESPONSE);
      render(<TeamSetup onNext={onNext} />);

      const nameField =
        screen.queryByLabelText(/team name/i) ||
        screen.queryByLabelText(/name/i) ||
        screen.queryByPlaceholderText(/team name/i) ||
        screen.queryByPlaceholderText(/name/i);
      const slugField =
        screen.queryByLabelText(/slug/i) ||
        screen.queryByPlaceholderText(/slug/i) ||
        screen.queryByLabelText(/identifier/i);

      await user.type(nameField!, "Acme Corp");
      // Slug auto-fills from the name; user clears + retypes to override.
      await user.clear(slugField!);
      await user.type(slugField!, "acme");

      const submitBtn =
        screen.queryByRole("button", { name: /create/i }) ||
        screen.queryByRole("button", { name: /submit/i }) ||
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /continue/i });
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
        screen.queryByLabelText(/name/i) ||
        screen.queryByPlaceholderText(/team name/i) ||
        screen.queryByPlaceholderText(/name/i);
      const slugField =
        screen.queryByLabelText(/slug/i) ||
        screen.queryByPlaceholderText(/slug/i) ||
        screen.queryByLabelText(/identifier/i);

      await user.type(nameField!, "Bad Corp");
      // Slug auto-fills from the name; user clears + retypes to override.
      await user.clear(slugField!);
      await user.type(slugField!, "bad");

      const submitBtn =
        screen.queryByRole("button", { name: /create/i }) ||
        screen.queryByRole("button", { name: /submit/i }) ||
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /continue/i });
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
        screen.queryByLabelText(/name/i) ||
        screen.queryByPlaceholderText(/team name/i) ||
        screen.queryByPlaceholderText(/name/i);
      const slugField =
        screen.queryByLabelText(/slug/i) ||
        screen.queryByPlaceholderText(/slug/i) ||
        screen.queryByLabelText(/identifier/i);

      await user.type(nameField!, "Bad Corp");
      // Slug auto-fills from the name; user clears + retypes to override.
      await user.clear(slugField!);
      await user.type(slugField!, "bad");

      const submitBtn =
        screen.queryByRole("button", { name: /create/i }) ||
        screen.queryByRole("button", { name: /submit/i }) ||
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /continue/i });
      await user.click(submitBtn!);

      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      expect(onNext).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("Join team mode", () => {
    /** Switch to join mode */
    async function switchToJoin() {
      const user = userEvent.setup();
      const joinSelector =
        screen.queryByRole("tab", { name: /join/i }) ||
        screen.queryByRole("button", { name: /join/i }) ||
        screen.queryByText(/join.*team/i);
      if (joinSelector) await user.click(joinSelector);
    }

    it("renders an invite code input field after switching to join mode", async () => {
      render(<TeamSetup onNext={vi.fn()} />);
      await switchToJoin();
      const codeField =
        screen.queryByLabelText(/invite/i) ||
        screen.queryByLabelText(/code/i) ||
        screen.queryByPlaceholderText(/invite/i) ||
        screen.queryByPlaceholderText(/code/i);
      expect(codeField).not.toBeNull();
    });

    it("renders a submit button in join mode", async () => {
      render(<TeamSetup onNext={vi.fn()} />);
      await switchToJoin();
      const submitBtn =
        screen.queryByRole("button", { name: /join/i }) ||
        screen.queryByRole("button", { name: /submit/i }) ||
        screen.queryByRole("button", { name: /continue/i });
      expect(submitBtn).not.toBeNull();
    });

    it("calls setTeam() with joinedViaInvite=true after successful join", async () => {
      const user = userEvent.setup();
      mockFetchSuccess(MOCK_JOIN_RESPONSE);
      render(<TeamSetup onNext={vi.fn()} />);
      await switchToJoin();

      const codeField =
        screen.queryByLabelText(/invite/i) ||
        screen.queryByLabelText(/code/i) ||
        screen.queryByPlaceholderText(/invite/i) ||
        screen.queryByPlaceholderText(/code/i);

      expect(codeField).not.toBeNull();
      await user.type(codeField!, "INVITE-XYZ");

      const submitBtn =
        screen.queryByRole("button", { name: /join/i }) ||
        screen.queryByRole("button", { name: /submit/i }) ||
        screen.queryByRole("button", { name: /continue/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        expect(mockSetTeam).toHaveBeenCalledTimes(1);
        const arg = mockSetTeam.mock.calls[0][0];
        expect(arg.joinedViaInvite).toBe(true);
      });
    });

    it("calls onNext() after successful join", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      mockFetchSuccess(MOCK_JOIN_RESPONSE);
      render(<TeamSetup onNext={onNext} />);
      await switchToJoin();

      const codeField =
        screen.queryByLabelText(/invite/i) ||
        screen.queryByLabelText(/code/i) ||
        screen.queryByPlaceholderText(/invite/i) ||
        screen.queryByPlaceholderText(/code/i);

      await user.type(codeField!, "INVITE-XYZ");

      const submitBtn =
        screen.queryByRole("button", { name: /join/i }) ||
        screen.queryByRole("button", { name: /submit/i }) ||
        screen.queryByRole("button", { name: /continue/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    });

    it("renders an error message when join API call fails", async () => {
      const user = userEvent.setup();
      mockFetchFailure(400, { error: "Invalid invite code" });
      render(<TeamSetup onNext={vi.fn()} />);
      await switchToJoin();

      const codeField =
        screen.queryByLabelText(/invite/i) ||
        screen.queryByLabelText(/code/i) ||
        screen.queryByPlaceholderText(/invite/i) ||
        screen.queryByPlaceholderText(/code/i);

      await user.type(codeField!, "BAD-CODE");

      const submitBtn =
        screen.queryByRole("button", { name: /join/i }) ||
        screen.queryByRole("button", { name: /submit/i }) ||
        screen.queryByRole("button", { name: /continue/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        const alert = screen.queryByRole("alert");
        const errorText = screen.queryByText(/error|failed|invalid|unable/i);
        expect(alert || errorText).not.toBeNull();
      });
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
