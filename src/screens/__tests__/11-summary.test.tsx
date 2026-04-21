import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Summary } from "../11-summary.js";

// ---------------------------------------------------------------------------
// Summary screen tests (US-018 + US-028)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks — must be declared before component imports
// ---------------------------------------------------------------------------

type DesktopStatus =
  | { status: "ready"; version: string }
  | { status: "not-installed" }
  | { status: "version-too-old"; version: string; required: string };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
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
// invoke mock helper — routes each Tauri command to a canned response.
// ---------------------------------------------------------------------------

function mockCommands(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    detect_claude_desktop: { status: "ready", version: "1.1.2500" } satisfies DesktopStatus,
    launch_claude_desktop: undefined,
    launch_claude_code: undefined,
    open_claude_download: undefined,
  };
  const all = { ...defaults, ...overrides };
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd in all) return Promise.resolve(all[cmd] as never);
    return Promise.resolve(undefined as never);
  });
  return all;
}

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
    mockCommands();
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
    expect(getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders '—' for missing team", () => {
    const { getAllByText } = render(
      <Summary wizardState={{ ...WIZARD_STATE_FIXTURE, team: null }} />
    );
    expect(getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("renders 'Personal HQ (no company)' when isPersonal and no team", () => {
    render(
      <Summary
        wizardState={{ ...WIZARD_STATE_FIXTURE, team: null, isPersonal: true }}
      />
    );
    expect(screen.getByText(/personal hq \(no company\)/i)).toBeInTheDocument();
    expect(screen.queryByText("Team name")).toBeNull();
    expect(screen.queryByText("Team slug")).toBeNull();
  });

  it("renders '—' for missing email", () => {
    const { getAllByText } = render(
      <Summary wizardState={{ ...WIZARD_STATE_FIXTURE, gitEmail: null }} />
    );
    expect(getAllByText("—").length).toBeGreaterThan(0);
  });

  // ── 3. Instruction card — always visible ──────────────────────────────────

  it("always renders the '/setup' instruction card", () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    expect(screen.getByText(/once claude opens, type/i)).toBeInTheDocument();
    expect(screen.getByText("/setup")).toBeInTheDocument();
  });

  // ── 4. Primary CTA — "ready" state ────────────────────────────────────────

  it("renders 'Open HQ in Claude' once desktop detection resolves to ready", async () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = await screen.findByRole("button", { name: /open hq in claude$/i });
    expect(btn).toBeDefined();
  });

  it("clicking 'Open HQ in Claude' invokes launch_claude_desktop with install path", async () => {
    const user = userEvent.setup();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = await screen.findByRole("button", { name: /open hq in claude$/i });
    await user.click(btn);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("launch_claude_desktop", {
        path: "/Users/testuser/HQ",
      });
    });
  });

  it("clicking primary CTA in ready state calls onLaunch", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} onLaunch={onLaunch} />);
    const btn = await screen.findByRole("button", { name: /open hq in claude$/i });
    await user.click(btn);
    await waitFor(() => {
      expect(onLaunch).toHaveBeenCalledTimes(1);
    });
  });

  // ── 5. Primary CTA — "not-installed" state → download ─────────────────────

  it("renders 'Download Claude' when desktop app is not installed", async () => {
    mockCommands({ detect_claude_desktop: { status: "not-installed" } });
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = await screen.findByRole("button", { name: /download claude/i });
    expect(btn).toBeDefined();
  });

  it("clicking 'Download Claude' invokes open_claude_download", async () => {
    mockCommands({ detect_claude_desktop: { status: "not-installed" } });
    const user = userEvent.setup();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = await screen.findByRole("button", { name: /download claude/i });
    await user.click(btn);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("open_claude_download");
    });
  });

  // ── 6. Primary CTA — "version-too-old" state → update ─────────────────────

  it("renders 'Update Claude' with version details when app is too old", async () => {
    mockCommands({
      detect_claude_desktop: {
        status: "version-too-old",
        version: "1.1.2395",
        required: "1.1.2396",
      },
    });
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = await screen.findByRole("button", { name: /update claude/i });
    expect(btn).toBeDefined();
    expect(screen.getByText(/installed: v1\.1\.2395/i)).toBeInTheDocument();
    expect(screen.getByText(/required: v1\.1\.2396/i)).toBeInTheDocument();
  });

  // ── 7. Secondary CTA — Terminal path ──────────────────────────────────────

  it("always renders the 'Or open in Terminal' secondary action", () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = screen.getByRole("button", { name: /or open in terminal/i });
    expect(btn).toBeDefined();
  });

  it("clicking 'Or open in Terminal' invokes launch_claude_code with install path", async () => {
    const user = userEvent.setup();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = screen.getByRole("button", { name: /or open in terminal/i });
    await user.click(btn);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("launch_claude_code", {
        path: "/Users/testuser/HQ",
      });
    });
  });

  it("clicking 'Or open in Terminal' calls onLaunch callback", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} onLaunch={onLaunch} />);
    const btn = screen.getByRole("button", { name: /or open in terminal/i });
    await user.click(btn);
    await waitFor(() => {
      expect(onLaunch).toHaveBeenCalledTimes(1);
    });
  });

  it("does NOT invoke launch_claude_code when installPath is null", async () => {
    const user = userEvent.setup();
    render(
      <Summary
        wizardState={{ ...WIZARD_STATE_FIXTURE, installPath: null }}
      />
    );
    const btn = screen.getByRole("button", { name: /or open in terminal/i });
    await user.click(btn);
    // Give any async work a moment to complete.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "launch_claude_code",
      expect.anything()
    );
  });

  // ── 8. Error surfacing ────────────────────────────────────────────────────

  it("surfaces a Terminal launch error inline", async () => {
    // Lazy factory — reject only when invoked, not eagerly, so the
    // rejection doesn't fire before a handler is attached.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "detect_claude_desktop") {
        return Promise.resolve({ status: "ready", version: "1.1.2500" } as never);
      }
      if (cmd === "launch_claude_code") {
        return Promise.reject(new Error("osascript failed")) as never;
      }
      return Promise.resolve(undefined as never);
    });
    const user = userEvent.setup();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = screen.getByRole("button", { name: /or open in terminal/i });
    await user.click(btn);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/osascript failed/i);
    });
  });

  // ── 9. Telemetry — pingSuccess on mount ───────────────────────────────────

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

    expect(mockPingSuccess).toHaveBeenCalledTimes(1);
  });

  // ── 10. No purple/indigo class names in DOM ───────────────────────────────

  it("does NOT use 'purple' class names in the DOM", async () => {
    const { container } = render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    // Wait for async detection effect to resolve before asserting.
    await screen.findByRole("button", { name: /open hq in claude$/i });
    expect(container.innerHTML).not.toMatch(/\bpurple\b/);
  });

  it("does NOT use 'indigo' class names in the DOM", async () => {
    const { container } = render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    await screen.findByRole("button", { name: /open hq in claude$/i });
    expect(container.innerHTML).not.toMatch(/\bindigo\b/);
  });
});
