import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Summary } from "../11-summary.js";

// ---------------------------------------------------------------------------
// Summary screen tests (US-018)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks — must be declared before component imports
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Telemetry mock
// ---------------------------------------------------------------------------

vi.mock("../../lib/telemetry.js", () => ({
  pingSuccess: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { pingSuccess } from "../../lib/telemetry.js";
const mockInvoke = vi.mocked(invoke);
const mockPingSuccess = vi.mocked(pingSuccess);

// ---------------------------------------------------------------------------
// Wizard-state fixture
// ---------------------------------------------------------------------------

const WIZARD_STATE_FIXTURE = {
  installPath: "/Users/testuser/HQ",
  team: { name: "Acme Corp", slug: "acme-corp" },
  gitEmail: "dev@acme.com",
  telemetryEnabled: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Summary screen (11-summary.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Tauri environment compatibility ────────────────────────────────────

  it("renders cleanly when Tauri APIs are mocked", () => {
    expect(() => {
      render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    }).not.toThrow();
  });

  // ── 2. Summary card — renders wizard-state fixture values ─────────────────

  it("renders the install path from wizard state", () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    expect(screen.getByText("/Users/testuser/HQ")).toBeDefined();
  });

  it("renders the team name from wizard state", () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    expect(screen.getByText("Acme Corp")).toBeDefined();
  });

  it("renders the team slug from wizard state", () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    expect(screen.getByText("acme-corp")).toBeDefined();
  });

  it("renders the email from wizard state", () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    expect(screen.getByText("dev@acme.com")).toBeDefined();
  });

  it("renders '—' for missing install path", () => {
    const { getAllByText } = render(
      <Summary wizardState={{ ...WIZARD_STATE_FIXTURE, installPath: null }} />
    );
    // Multiple '—' may appear (one per missing field), so check at least one.
    expect(getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders '—' for missing team", () => {
    const { getAllByText } = render(
      <Summary wizardState={{ ...WIZARD_STATE_FIXTURE, team: null }} />
    );
    expect(getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("renders '—' for missing email", () => {
    const { getAllByText } = render(
      <Summary wizardState={{ ...WIZARD_STATE_FIXTURE, gitEmail: null }} />
    );
    expect(getAllByText("—").length).toBeGreaterThan(0);
  });

  // ── 3. Launch button is present ───────────────────────────────────────────

  it("renders 'Open HQ in Claude Code' button", () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = screen.queryByRole("button", { name: /open hq in claude code/i });
    expect(btn).not.toBeNull();
  });

  // ── 4. Clicking launch button calls invoke("launch_claude_code") ──────────

  it("clicking 'Open HQ in Claude Code' calls invoke('launch_claude_code') with the install path", async () => {
    const user = userEvent.setup();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);

    const btn = screen.getByRole("button", { name: /open hq in claude code/i });
    await user.click(btn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("launch_claude_code", {
        path: "/Users/testuser/HQ",
      });
    });
  });

  it("clicking launch button calls onLaunch callback", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} onLaunch={onLaunch} />);

    const btn = screen.getByRole("button", { name: /open hq in claude code/i });
    await user.click(btn);

    await waitFor(() => {
      expect(onLaunch).toHaveBeenCalledTimes(1);
    });
  });

  it("does NOT call invoke('launch_claude_code') when installPath is null", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    render(
      <Summary
        wizardState={{ ...WIZARD_STATE_FIXTURE, installPath: null }}
        onLaunch={onLaunch}
      />
    );

    const btn = screen.getByRole("button", { name: /open hq in claude code/i });
    await user.click(btn);

    await waitFor(() => {
      expect(onLaunch).toHaveBeenCalledTimes(1);
    });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "launch_claude_code",
      expect.anything()
    );
  });

  // ── 5. Telemetry — pingSuccess on mount ───────────────────────────────────

  it("calls pingSuccess on mount when telemetryEnabled=true", async () => {
    render(<Summary wizardState={{ ...WIZARD_STATE_FIXTURE, telemetryEnabled: true }} />);

    await waitFor(() => {
      expect(mockPingSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it("does NOT call pingSuccess when telemetryEnabled=false", () => {
    render(<Summary wizardState={{ ...WIZARD_STATE_FIXTURE, telemetryEnabled: false }} />);
    expect(mockPingSuccess).not.toHaveBeenCalled();
  });

  it("does NOT call pingSuccess twice on re-render with same telemetryEnabled value", async () => {
    const { rerender } = render(
      <Summary wizardState={{ ...WIZARD_STATE_FIXTURE, telemetryEnabled: true }} />
    );

    await waitFor(() => expect(mockPingSuccess).toHaveBeenCalledTimes(1));

    rerender(
      <Summary wizardState={{ ...WIZARD_STATE_FIXTURE, telemetryEnabled: true }} />
    );

    // Should still be 1 — the effect deps haven't changed.
    expect(mockPingSuccess).toHaveBeenCalledTimes(1);
  });

  // ── 6. No purple/indigo class names in DOM ────────────────────────────────

  it("does NOT use 'purple' class names in the DOM", () => {
    const { container } = render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    expect(container.innerHTML).not.toMatch(/\bpurple\b/);
  });

  it("does NOT use 'indigo' class names in the DOM", () => {
    const { container } = render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    expect(container.innerHTML).not.toMatch(/\bindigo\b/);
  });
});
