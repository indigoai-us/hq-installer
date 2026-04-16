import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamSetup } from "../03-team.js";

// ---------------------------------------------------------------------------
// TeamSetup screen tests (US-004)
//
// Reworked from team creation to company detection. The screen now calls
// resolveUserCompany() on mount and displays the result.
// ---------------------------------------------------------------------------

// Tauri API mocks
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

// wizard-state mock
vi.mock("../../lib/wizard-state.js", () => ({
  getWizardState: vi.fn(() => ({ telemetryEnabled: true, team: null })),
  setTeam: vi.fn(),
  setTelemetryEnabled: vi.fn(),
  clearWizardState: vi.fn(),
}));

import * as wizardState from "../../lib/wizard-state.js";
const mockSetTeam = vi.mocked(wizardState.setTeam);

// cognito mock
const { MOCK_ACCESS_TOKEN } = vi.hoisted(() => ({
  MOCK_ACCESS_TOKEN: "mock-access-token-123",
}));

vi.mock("../../lib/cognito.js", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({
    sub: "sub-123",
    email: "test@example.com",
    tokens: {
      accessToken: MOCK_ACCESS_TOKEN,
      idToken: "mock-id-token",
      refreshToken: "mock-refresh",
      expiresAt: Date.now() + 3600_000,
    },
  }),
}));

// vault-handoff mock
const mockResolveUserCompany = vi.fn();
vi.mock("../../lib/vault-handoff.js", () => ({
  resolveUserCompany: (...args: unknown[]) => mockResolveUserCompany(...args),
}));

describe("TeamSetup (company detection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading spinner while detecting company", () => {
    // Never-resolving promise to keep loading state
    mockResolveUserCompany.mockReturnValue(new Promise(() => {}));
    render(<TeamSetup />);
    expect(screen.getByText(/looking up your company/i)).toBeInTheDocument();
  });

  it("displays company details when found", async () => {
    mockResolveUserCompany.mockResolvedValue({
      found: true,
      companyUid: "cmp_001",
      companySlug: "acme",
      companyName: "Acme Inc",
      bucketName: "hq-vault-acme",
      personUid: "per_001",
      role: "admin",
    });

    render(<TeamSetup />);

    await waitFor(() => {
      expect(screen.getByText("Your company is ready")).toBeInTheDocument();
    });
    expect(screen.getByText("Acme Inc")).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(screen.getByText(/admin/i)).toBeInTheDocument();
  });

  it("stores team metadata in wizard state when company found", async () => {
    mockResolveUserCompany.mockResolvedValue({
      found: true,
      companyUid: "cmp_001",
      companySlug: "acme",
      companyName: "Acme Inc",
      bucketName: "hq-vault-acme",
      personUid: "per_001",
      role: "admin",
    });

    render(<TeamSetup />);

    await waitFor(() => {
      expect(mockSetTeam).toHaveBeenCalledWith({
        teamId: "cmp_001",
        companyId: "cmp_001",
        slug: "acme",
        name: "Acme Inc",
        joinedViaInvite: false,
      });
    });
  });

  it("shows web onboarding link when no company found", async () => {
    mockResolveUserCompany.mockResolvedValue({ found: false });

    render(<TeamSetup />);

    await waitFor(() => {
      expect(screen.getByText("No company found")).toBeInTheDocument();
    });
    expect(screen.getByText(/complete web onboarding first/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /go to web onboarding/i });
    expect(link).toHaveAttribute("href", "https://onboarding.indigo-hq.com");
  });

  it("shows error state on network failure", async () => {
    mockResolveUserCompany.mockRejectedValue(new Error("Network error"));

    render(<TeamSetup />);

    await waitFor(() => {
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });
    expect(screen.getByText("Network error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("passes access token to resolveUserCompany", async () => {
    mockResolveUserCompany.mockResolvedValue({ found: false });

    render(<TeamSetup />);

    await waitFor(() => {
      expect(mockResolveUserCompany).toHaveBeenCalledWith(MOCK_ACCESS_TOKEN);
    });
  });

  it("calls onNext when Continue is clicked after company found", async () => {
    const onNext = vi.fn();
    mockResolveUserCompany.mockResolvedValue({
      found: true,
      companyUid: "cmp_001",
      companySlug: "acme",
      companyName: "Acme Inc",
      bucketName: "hq-vault-acme",
      personUid: "per_001",
      role: "admin",
    });

    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();

    render(<TeamSetup onNext={onNext} />);

    await waitFor(() => {
      expect(screen.getByText("Your company is ready")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(onNext).toHaveBeenCalledOnce();
  });
});
