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
  invoke: vi.fn(),
}));

// `open` from the shell plugin opens external URLs (download CTA).
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../../lib/import-existing.js", () => ({
  readInstallerImportBreadcrumb: vi.fn().mockResolvedValue(null),
}));

import { invoke } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { pingSuccess } from "../../lib/telemetry.js";
import { readInstallerImportBreadcrumb } from "../../lib/import-existing.js";
const mockInvoke = vi.mocked(invoke);
const mockOpenExternal = vi.mocked(openExternal);
const mockPingSuccess = vi.mocked(pingSuccess);
const mockReadInstallerImportBreadcrumb = vi.mocked(readInstallerImportBreadcrumb);

/** Configure the invoke mock with a command-aware default.
 *  Pass `claudeInstalled=true|false` to control the desktop-probe branch. */
function setupInvokeMock({
  claudeInstalled = true,
}: { claudeInstalled?: boolean } = {}): void {
  mockInvoke.mockImplementation(async (command: string): Promise<unknown> => {
    if (command === "claude_desktop_installed") return claudeInstalled;
    // launch_claude_desktop / launch_claude_code resolve undefined.
    return undefined;
  });
}

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
    // Default: Claude Desktop is installed. Tests covering the missing-app
    // branch override via setupInvokeMock({ claudeInstalled: false }).
    setupInvokeMock();
    mockReadInstallerImportBreadcrumb.mockResolvedValue(null);
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

  // ── 2b. Deferred Claude import CTA ───────────────────────────────────────

  it("shows the deferred Claude import card when the breadcrumb reports artifacts", async () => {
    mockReadInstallerImportBreadcrumb.mockResolvedValue({
      scanId: "2026-06-18T12-34-56-000Z",
      scanDir: "workspace/imports/2026-06-18T12-34-56-000Z",
      ranAt: "2026-06-18T12:34:56.000Z",
      codexApplied: true,
      discoveryOk: true,
      claudeCounts: { commands: 2, skills: 1 },
      totalClaudeArtifacts: 3,
      deferred: true,
    });

    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);

    expect(
      await screen.findByText(/finish importing your claude setup/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/we found 3 claude artifacts\./i),
    ).toBeInTheDocument();
    expect(screen.getByText("/import-claude")).toBeInTheDocument();
    expect(
      screen.getByText(/codex parity was applied automatically\./i),
    ).toBeInTheDocument();
  });

  it("hides the deferred Claude import card when the breadcrumb is absent", async () => {
    mockReadInstallerImportBreadcrumb.mockResolvedValue(null);
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);

    await waitFor(() => {
      expect(
        screen.queryByText(/finish importing your claude setup/i),
      ).toBeNull();
    });
  });

  it("hides the deferred Claude import card when the breadcrumb reports zero artifacts", async () => {
    mockReadInstallerImportBreadcrumb.mockResolvedValue({
      scanId: "2026-06-18T12-34-56-000Z",
      scanDir: "workspace/imports/2026-06-18T12-34-56-000Z",
      ranAt: "2026-06-18T12:34:56.000Z",
      codexApplied: true,
      discoveryOk: true,
      claudeCounts: {},
      totalClaudeArtifacts: 0,
      deferred: true,
    });

    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);

    await waitFor(() => {
      expect(
        screen.queryByText(/finish importing your claude setup/i),
      ).toBeNull();
    });
  });

  // ── 3. Claude Desktop CTA — primary path (Desktop IS installed) ───────────

  it("renders a 'Launch Claude Desktop' button when Claude is installed", async () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = await screen.findByRole("button", {
      name: /launch claude desktop/i,
    });
    expect(btn).not.toBeNull();
  });

  it("clicking 'Launch Claude Desktop' opens claude://code/new with /setup and folder", async () => {
    const user = userEvent.setup();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = await screen.findByRole("button", {
      name: /launch claude desktop/i,
    });
    await user.click(btn);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("open_claude_code_link", {
        url: "claude://code/new?q=%2Fsetup&folder=%2FUsers%2Ftestuser%2FHQ",
      });
    });
  });

  it("does NOT invoke launch_claude_desktop anymore (deep link replaces it)", async () => {
    const user = userEvent.setup();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = await screen.findByRole("button", {
      name: /launch claude desktop/i,
    });
    await user.click(btn);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "open_claude_code_link",
        expect.anything(),
      );
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("launch_claude_desktop");
  });

  it("renders Claude Desktop instructions including the install path", () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const text = document.body.textContent ?? "";
    expect(text.toLowerCase()).toMatch(/open in claude desktop/);
    expect(text).toContain("/Users/testuser/HQ");
  });

  it("instructs the user to use Claude Code with the local filesystem (not Connectors)", async () => {
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    // Wait for the desktop-installed probe to settle so the CTA paints.
    await screen.findByRole("button", { name: /launch claude desktop/i });
    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).toMatch(/claude code/);
    expect(text).toMatch(/local filesystem/);
    // Sanity: the prior wrong instruction (Connectors) is gone.
    expect(text).not.toMatch(/connectors/);
  });

  // ── 3b. Claude Desktop CTA — Desktop NOT installed branch ────────────────

  it("renders a 'Download Claude Desktop' CTA when Claude is missing", async () => {
    setupInvokeMock({ claudeInstalled: false });
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = await screen.findByRole("button", {
      name: /download claude desktop/i,
    });
    expect(btn).not.toBeNull();
    // Launch button should NOT be shown in this branch.
    expect(
      screen.queryByRole("button", { name: /launch claude desktop/i }),
    ).toBeNull();
  });

  it("clicking 'Download Claude Desktop' opens the Anthropic quickstart page externally", async () => {
    setupInvokeMock({ claudeInstalled: false });
    const user = userEvent.setup();
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = await screen.findByRole("button", {
      name: /download claude desktop/i,
    });
    await user.click(btn);
    await waitFor(() => {
      expect(mockOpenExternal).toHaveBeenCalledWith(
        "https://code.claude.com/docs/en/desktop-quickstart",
      );
    });
  });

  it("renders a 'Claude Desktop quickstart' link even when the app IS installed", async () => {
    // Discreet help link beneath the Launch button — surfaces the same
    // quickstart URL so users sharing this machine still see "what next".
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    // Wait for installed-branch CTA so the link below it has rendered.
    await screen.findByRole("button", { name: /launch claude desktop/i });
    const link = screen.queryByRole("button", {
      name: /claude desktop quickstart/i,
    });
    expect(link).not.toBeNull();
  });

  it("falls back to download CTA if claude_desktop_installed probe throws", async () => {
    mockInvoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "claude_desktop_installed") {
        throw new Error("rust panic");
      }
      return undefined;
    });
    render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
    const btn = await screen.findByRole("button", {
      name: /download claude desktop/i,
    });
    expect(btn).not.toBeNull();
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
      expect(mockPingSuccess).toHaveBeenCalledWith("test");
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

  // ── 5b. US-008 — reflects the 5-step flow; no references to removed steps ─

  describe("US-008 — no references to removed steps", () => {
    it("does NOT reference the removed 'packages' step", () => {
      render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
      const text = (document.body.textContent ?? "").toLowerCase();
      expect(text).not.toMatch(/\bpackages?\b/);
      expect(text).not.toMatch(/pack catalog/);
    });

    it("does NOT reference the removed 'prerequisites' step", () => {
      render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
      const text = (document.body.textContent ?? "").toLowerCase();
      expect(text).not.toMatch(/prerequisite/);
    });

    it("does NOT reference 'menubar' as a standalone step", () => {
      render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
      const text = (document.body.textContent ?? "").toLowerCase();
      expect(text).not.toMatch(/menubar/);
    });

    it("does NOT reference 'personalize' or 'indexing' as standalone steps", () => {
      render(<Summary wizardState={WIZARD_STATE_FIXTURE} />);
      const text = (document.body.textContent ?? "").toLowerCase();
      // These were folded into the unified setup orchestrator (US-004); the
      // summary should describe the end state, not the removed standalone
      // steps.
      expect(text).not.toMatch(/personalize/);
      expect(text).not.toMatch(/indexing/);
    });
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
