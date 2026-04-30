import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Summary } from "../11-summary.js";

// ---------------------------------------------------------------------------
// Summary screen tests (US-018, revised 2026-04-29)
//
// Claude Desktop is the primary CTA; Claude Code (Terminal) is a secondary
// text link. Tests cover both paths plus the install-manifest finalize.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks — must be declared before component imports
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// fs + app are touched by install-manifest. Stub so the manifest finalize
// runs without writing to disk.
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockRejectedValue(new Error("not found")),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(false),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("test"),
}));

vi.mock("../../lib/telemetry.js", () => ({
  pingSuccess: vi.fn().mockResolvedValue(undefined),
  pingFailure: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { pingSuccess } from "../../lib/telemetry.js";
const mockInvoke = vi.mocked(invoke);
const mockPingSuccess = vi.mocked(pingSuccess);

// Fixture
const WIZARD_STATE_FIXTURE = {
  installPath: "/Users/testuser/HQ",
  team: { name: "Acme Corp", slug: "acme-corp" },
  gitEmail: "dev@acme.com",
  telemetryEnabled: true,
};

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
    // Path appears in both the summary card and the Claude Desktop callout —
    // either occurrence is sufficient.
    const matches = screen.getAllByText("/Users/testuser/HQ");
    expect(matches.length).toBeGreaterThanOrEqual(1);
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
      <Summary wizardState={{ ...WIZARD_STATE_FIXTURE, installPath: null }} />,
    );
    expect(getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders '—' for missing team", () => {
    const { getAllByText } = render(
      <Summary wizardState={{ ...WIZARD_STATE_FIXTURE, team: null }} />,
    );
    expect(getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("renders 'Personal HQ (no company)' when isPersonal and no team", () => {
    render(
      <Summary
        wizardState={{ ...WIZARD_STATE_FIXTURE, team: null, isPersonal: true }}
      />,
    );
    expect(screen.getByText(/personal hq \(no company\)/i)).toBeInTheDocument();
    expect(screen.queryByText("Team name")).toBeNull();
    expect(screen.queryByText("Team slug")).toBeNull();
  });

  it("renders '—' for missing email", () => {
    const { getAllByText } = render(
      <Summary wizardState={{ ...WIZARD_STATE_FIXTURE, gitEmail: null }} />,
    );
    expect(getAllByText("—").length).toBeGreaterThan(0);
  });

  // ── 3. Claude Desktop CTA — primary path ──────────────────────────────────

  it("renders a 'Launch Claude Desktop' primary button", () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = screen.queryByRole("button", { name: /launch claude desktop/i });
    expect(btn).not.toBeNull();
  });

  it("clicking 'Launch Claude Desktop' calls invoke('launch_claude_desktop')", async () => {
    const user = userEvent.setup();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = screen.getByRole("button", { name: /launch claude desktop/i });
    await user.click(btn);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("launch_claude_desktop");
    });
  });

  it("renders Claude Desktop instructions including the install path", () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const text = document.body.textContent ?? "";
    expect(text.toLowerCase()).toMatch(/open in claude desktop/);
    expect(text).toContain("/Users/testuser/HQ");
  });

  // ── 4. Claude Code (Terminal) — secondary text link ───────────────────────

  it("renders 'Open Claude Code in Terminal' as a secondary link", () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const link = screen.queryByRole("button", {
      name: /open claude code in terminal/i,
    });
    expect(link).not.toBeNull();
  });

  it("clicking the Claude Code text link calls invoke('launch_claude_code', { path })", async () => {
    const user = userEvent.setup();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const link = screen.getByRole("button", {
      name: /open claude code in terminal/i,
    });
    await user.click(link);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("launch_claude_code", {
        path: "/Users/testuser/HQ",
      });
    });
  });

  it("clicking the Claude Code text link calls onLaunch callback", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} onLaunch={onLaunch} />);
    const link = screen.getByRole("button", {
      name: /open claude code in terminal/i,
    });
    await user.click(link);
    await waitFor(() => {
      expect(onLaunch).toHaveBeenCalledTimes(1);
    });
  });

  it("does NOT call invoke('launch_claude_code') when installPath is null", async () => {
    const user = userEvent.setup();
    render(
      <Summary
        wizardState={{ ...WIZARD_STATE_FIXTURE, installPath: null }}
        onLaunch={vi.fn()}
      />,
    );
    const link = screen.queryByRole("button", {
      name: /open claude code in terminal/i,
    });
    if (link && !(link as HTMLButtonElement).disabled) {
      await user.click(link);
    }
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "launch_claude_code",
      expect.anything(),
    );
  });

  // ── 5. Telemetry — pingSuccess on mount ───────────────────────────────────

  it("calls pingSuccess on mount when telemetryEnabled=true", async () => {
    render(
      <Summary wizardState={{ ...WIZARD_STATE_FIXTURE, telemetryEnabled: true }} />,
    );
    await waitFor(() => {
      expect(mockPingSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it("does NOT call pingSuccess when telemetryEnabled=false", () => {
    render(
      <Summary
        wizardState={{ ...WIZARD_STATE_FIXTURE, telemetryEnabled: false }}
      />,
    );
    expect(mockPingSuccess).not.toHaveBeenCalled();
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
