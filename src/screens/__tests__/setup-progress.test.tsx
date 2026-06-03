import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SetupProgress } from "../setup-progress.js";

// ---------------------------------------------------------------------------
// SetupProgress orchestrator tests — US-004
//
// The screen runs five stages behind a single progress bar + one status
// line, with no intermediate input:
//   deps → git-init → personalize → indexing → menubar
// (Cloud file sync was removed — HQ Sync owns it; company detection folded
//  into the personalize stage.)
//
// Asserted behavior:
//   - Exactly one progress bar is rendered (role="progressbar").
//   - A single status line describes the current activity (no per-stage rows).
//   - No Next / Continue / Skip controls appear; only Retry on failure.
//   - A failed stage does NOT discard prior completed stages.
//   - install-manifest records each stage outcome.
//   - onNext() fires automatically when every stage succeeds.
// ---------------------------------------------------------------------------

// ── Tauri mocks ────────────────────────────────────────────────────────────

type EventCallback = (event: { payload: unknown }) => void;
const listenCallbacks = new Map<string, EventCallback[]>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: EventCallback) => {
    if (!listenCallbacks.has(event)) {
      listenCallbacks.set(event, []);
    }
    listenCallbacks.get(event)!.push(handler);

    // Auto-complete spawn_process exits so the indexing stage advances
    // without each test having to fire the exit event by hand. Tests that
    // need a failure inject one explicitly (see "indexing failure" case).
    if (event.endsWith("/exit") && !event.includes("__manual__")) {
      queueMicrotask(() => {
        const handlers = listenCallbacks.get(event) ?? [];
        for (const h of handlers) {
          h({ payload: { code: 0, success: true } });
        }
      });
    }
    return () => {
      const handlers = listenCallbacks.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(false),
  readTextFile: vi.fn().mockResolvedValue("{}"),
  BaseDirectory: { Home: "Home" },
}));

// ── Lib mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/deps-install", () => ({
  runDepsInstall: vi.fn(),
}));

vi.mock("@/lib/personalize-writer", () => ({
  personalize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cognito", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/lib/vault-handoff", () => ({
  listUserCompanies: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/wizard-state", () => ({
  getWizardState: vi.fn(() => ({
    telemetryEnabled: true,
    team: null,
    isPersonal: true,
    installPath: "/tmp/hq",
    gitName: null,
    gitEmail: null,
    personalized: false,
  })),
  setGitIdentity: vi.fn(),
  setIsPersonal: vi.fn(),
  setPersonalized: vi.fn(),
  setTeam: vi.fn(),
}));

vi.mock("@/lib/install-manifest", () => ({
  getInstallerVersion: vi.fn().mockResolvedValue("0.0.0-test"),
  recordDependencies: vi.fn().mockResolvedValue(undefined),
  recordStepStart: vi.fn().mockResolvedValue(undefined),
  recordStepOk: vi.fn().mockResolvedValue(undefined),
  recordStepFailure: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports of mocked symbols (after vi.mock so vitest can rewrite) ───────

import { invoke } from "@tauri-apps/api/core";
import { runDepsInstall } from "@/lib/deps-install";
import { personalize } from "@/lib/personalize-writer";
import { getCurrentUser } from "@/lib/cognito";
import { listUserCompanies } from "@/lib/vault-handoff";
import {
  setGitIdentity,
  setIsPersonal,
  setTeam,
} from "@/lib/wizard-state";
import {
  recordStepStart,
  recordStepOk,
  recordStepFailure,
  recordDependencies,
} from "@/lib/install-manifest";

const mockInvoke = vi.mocked(invoke);
const mockRunDepsInstall = vi.mocked(runDepsInstall);
const mockPersonalize = vi.mocked(personalize);
const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockListUserCompanies = vi.mocked(listUserCompanies);
const mockRecordStepStart = vi.mocked(recordStepStart);
const mockRecordStepOk = vi.mocked(recordStepOk);
const mockRecordStepFailure = vi.mocked(recordStepFailure);
const mockRecordDependencies = vi.mocked(recordDependencies);
const mockSetGitIdentity = vi.mocked(setGitIdentity);
const mockSetIsPersonal = vi.mocked(setIsPersonal);
const mockSetTeam = vi.mocked(setTeam);

// ── Helpers ───────────────────────────────────────────────────────────────

const USER = {
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
};

function setDepsAllOk() {
  mockRunDepsInstall.mockResolvedValue({
    allRequiredOk: true,
    results: [
      { id: "node", label: "Node.js", optional: false, status: "ok" },
      { id: "yq", label: "yq", optional: false, status: "ok" },
      { id: "qmd", label: "qmd", optional: false, status: "ok" },
      { id: "hq-cli", label: "HQ CLI", optional: false, status: "ok" },
      { id: "git", label: "Git", optional: true, status: "skipped" },
    ],
  });
}

function setDepsFailNode() {
  mockRunDepsInstall.mockResolvedValue({
    allRequiredOk: false,
    results: [
      {
        id: "node",
        label: "Node.js",
        optional: false,
        status: "failed",
        error: "network unreachable",
      },
    ],
  });
}

function buildInvokeMock() {
  let counter = 0;
  return vi.fn(async (command: string): Promise<unknown> => {
    if (command === "git_init") return "0123456789abcdef0123456789abcdef01234567";
    if (command === "spawn_process") return `handle-${++counter}`;
    if (command === "install_menubar_app") {
      return { success: true, appPath: "/Applications/HQ Sync.app", error: null };
    }
    if (command === "launch_menubar_app") return undefined;
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SetupProgress orchestrator (setup-progress.tsx) — US-004", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenCallbacks.clear();

    setDepsAllOk();
    mockGetCurrentUser.mockResolvedValue(USER);
    mockListUserCompanies.mockResolvedValue([]);
    mockPersonalize.mockResolvedValue(undefined);
    mockInvoke.mockImplementation(buildInvokeMock());
  });

  // ── 1. Render contract — single progress bar, no input controls ─────────

  describe("render contract", () => {
    it("renders the 'Setting up HQ' heading", () => {
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      expect(screen.getByText(/setting up hq/i)).toBeTruthy();
    });

    it("renders exactly one progress bar (role='progressbar')", () => {
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      const bars = screen.getAllByRole("progressbar");
      expect(bars.length).toBe(1);
    });

    it("does NOT render a Next, Continue, or Skip button on initial mount", () => {
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      // No buttons except possibly the Details disclosure on stages, which is
      // labelled "Details"/"Hide" — assert no flow-control buttons exist.
      const allButtons = screen.queryAllByRole("button");
      const flowControl = allButtons.filter((b) =>
        /next|continue|skip/i.test(b.textContent ?? ""),
      );
      expect(flowControl.length).toBe(0);
    });

    it("does NOT render a name or text input", () => {
      const { container } = render(
        <SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />,
      );
      const inputs = container.querySelectorAll("input");
      expect(inputs.length).toBe(0);
    });

    it("auto-starts on mount — runDepsInstall is invoked", async () => {
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => expect(mockRunDepsInstall).toHaveBeenCalled());
    });

    it("renders a single status line instead of per-stage rows", () => {
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      expect(screen.getByTestId("status-line")).toBeTruthy();
      // The old per-stage rows had a "Details" disclosure — it's gone now.
      expect(screen.queryByRole("button", { name: /details/i })).toBeNull();
    });

    it("never shows a 'Syncing your HQ' step (s3 sync removed — HQ Sync owns it)", async () => {
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => expect(mockRunDepsInstall).toHaveBeenCalled());
      expect((document.body.textContent ?? "").toLowerCase()).not.toMatch(
        /syncing your hq/,
      );
    });
  });

  // ── 2. Successful end-to-end run ────────────────────────────────────────

  describe("successful end-to-end run", () => {
    it("calls onNext() exactly once after every stage finishes", async () => {
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });
    });

    it("invokes git_init with the Google identity (no form)", async () => {
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(
          "git_init",
          expect.objectContaining({
            path: "/tmp/hq",
            name: "Jane Doe",
            email: "jane@example.com",
          }),
        ),
      );
      expect(mockSetGitIdentity).toHaveBeenCalledWith(
        "Jane Doe",
        "jane@example.com",
      );
    });

    it("invokes install_menubar_app for the HQ Sync stage", async () => {
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith("install_menubar_app"),
      );
    });

    it("calls personalize() with the Google name (no form)", async () => {
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() =>
        expect(mockPersonalize).toHaveBeenCalledWith(
          expect.objectContaining({ name: "Jane Doe" }),
          "/tmp/hq",
        ),
      );
    });

    it("flips isPersonal=true when the user has no cloud companies", async () => {
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() =>
        expect(mockSetIsPersonal).toHaveBeenCalledWith(true),
      );
      expect(mockSetTeam).not.toHaveBeenCalled();
    });
  });

  // ── 3. Stage failure — error UI + Retry, prior stages preserved ────────

  describe("stage failure", () => {
    it("shows a Retry button when deps fails", async () => {
      setDepsFailNode();
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => {
        expect(screen.queryByTestId("retry-button")).not.toBeNull();
      });
    });

    it("marks the failed stage with status='failed' in the DOM", async () => {
      setDepsFailNode();
      const { container } = render(
        <SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />,
      );
      await waitFor(() => {
        const row = container.querySelector('[data-stage="deps"]');
        expect(row?.getAttribute("data-status")).toBe("failed");
      });
    });

    it("does NOT call onNext when deps fails", async () => {
      setDepsFailNode();
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => {
        expect(screen.queryByTestId("retry-button")).not.toBeNull();
      });
      expect(onNext).not.toHaveBeenCalled();
    });

    it("resumes from the failed stage on Retry — prior stages are NOT re-run", async () => {
      // First run: deps OK → git-init fails. Retry should NOT re-call
      // runDepsInstall but SHOULD re-invoke git_init.
      let gitCalls = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "git_init") {
          gitCalls += 1;
          if (gitCalls === 1) throw new Error("git refused");
          return "0123456789abcdef0123456789abcdef01234567";
        }
        if (cmd === "spawn_process") return `handle-${gitCalls}`;
        if (cmd === "install_menubar_app") {
          return { success: true, appPath: "/x", error: null };
        }
        return undefined;
      });

      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);

      await waitFor(() =>
        expect(screen.queryByTestId("retry-button")).not.toBeNull(),
      );
      // deps ran exactly once.
      expect(mockRunDepsInstall).toHaveBeenCalledTimes(1);

      await act(async () => {
        await userEvent.click(screen.getByTestId("retry-button"));
      });

      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });
      // deps STILL ran only once — Retry resumes from git-init.
      expect(mockRunDepsInstall).toHaveBeenCalledTimes(1);
      // git_init re-invoked on retry.
      expect(gitCalls).toBe(2);
    });
  });

  // ── 4. install-manifest journaling ──────────────────────────────────────

  describe("install-manifest journaling", () => {
    it("records dep snapshot via recordDependencies", async () => {
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => expect(mockRecordDependencies).toHaveBeenCalled());
    });

    it("records start + ok for the deps stage on success", async () => {
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalled(), {
        timeout: 5000,
      });

      expect(mockRecordStepStart).toHaveBeenCalledWith(
        "/tmp/hq",
        expect.any(String),
        "deps",
      );
      expect(mockRecordStepOk).toHaveBeenCalledWith(
        "/tmp/hq",
        expect.any(String),
        "deps",
      );
    });

    it("records a failure for the deps stage when deps fails", async () => {
      setDepsFailNode();
      render(<SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockRecordStepFailure).toHaveBeenCalledWith(
          "/tmp/hq",
          expect.any(String),
          "deps",
          expect.any(String),
        );
      });
    });

    it("records start + ok for every stage on a clean success run", async () => {
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalled(), {
        timeout: 5000,
      });

      const startedStages = mockRecordStepStart.mock.calls.map((c) => c[2]);
      // Every stage in the contract order is journaled exactly once.
      expect(startedStages).toEqual([
        "deps",
        "git-init",
        "personalize",
        "indexing",
        "menubar",
      ]);
    });
  });

  // ── 5. UI policy — no purple/indigo monochrome ──────────────────────────

  describe("UI policy", () => {
    it("does NOT use 'purple' class names in the DOM", () => {
      const { container } = render(
        <SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />,
      );
      expect(container.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("does NOT use 'indigo' class names in the DOM", () => {
      const { container } = render(
        <SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />,
      );
      expect(container.innerHTML).not.toMatch(/\bindigo\b/);
    });
  });
});
