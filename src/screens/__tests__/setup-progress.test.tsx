import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SetupProgress } from "../setup-progress.js";

// ---------------------------------------------------------------------------
// SetupProgress orchestrator tests — US-004
//
// The screen runs eight stages behind a single progress bar + one status
// line, with no intermediate input:
//   deps → initial-sync → packages → git-init → personalize → import
//       → indexing → menubar
// (initial-sync provisions the personal vault and spawns the hq-cloud-sync
//  runner in the background — best-effort, never blocks; company detection
//  is folded into the personalize stage, and the merged import stage applies
//  Codex parity while deferring Claude adoption to `/import-claude`.)
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
  rename: vi.fn().mockResolvedValue(undefined),
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
  claimPendingInvitesForUser: vi.fn().mockResolvedValue(true),
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
  recordImport: vi.fn().mockResolvedValue(undefined),
  recordPacks: vi.fn().mockResolvedValue(undefined),
  recordStepStart: vi.fn().mockResolvedValue(undefined),
  recordStepOk: vi.fn().mockResolvedValue(undefined),
  recordStepFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/initial-sync", () => ({
  startInitialCloudSync: vi
    .fn()
    .mockResolvedValue({ personUid: "prs_1", handle: "h" }),
}));

// Default packs default to an empty set so the existing flow tests aren't
// perturbed by pack installs; the "packages stage" describe sets a real list.
vi.mock("@/lib/default-packs", () => ({
  getDefaultPacks: vi.fn(() => []),
}));

vi.mock("@/lib/import-existing", () => ({
  runExistingImport: vi.fn(),
}));

// ── Imports of mocked symbols (after vi.mock so vitest can rewrite) ───────

import { invoke } from "@tauri-apps/api/core";
import { runDepsInstall } from "@/lib/deps-install";
import { personalize } from "@/lib/personalize-writer";
import { getCurrentUser } from "@/lib/cognito";
import {
  claimPendingInvitesForUser,
  listUserCompanies,
} from "@/lib/vault-handoff";
import { startInitialCloudSync } from "@/lib/initial-sync";
import { getDefaultPacks } from "@/lib/default-packs";
import { runExistingImport } from "@/lib/import-existing";
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
  recordImport,
  recordPacks,
} from "@/lib/install-manifest";

const mockInvoke = vi.mocked(invoke);
const mockRunDepsInstall = vi.mocked(runDepsInstall);
const mockPersonalize = vi.mocked(personalize);
const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockListUserCompanies = vi.mocked(listUserCompanies);
const mockClaimPendingInvitesForUser = vi.mocked(claimPendingInvitesForUser);
const mockStartInitialCloudSync = vi.mocked(startInitialCloudSync);
const mockGetDefaultPacks = vi.mocked(getDefaultPacks);
const mockRunExistingImport = vi.mocked(runExistingImport);
const mockRecordStepStart = vi.mocked(recordStepStart);
const mockRecordStepOk = vi.mocked(recordStepOk);
const mockRecordStepFailure = vi.mocked(recordStepFailure);
const mockRecordDependencies = vi.mocked(recordDependencies);
const mockRecordImport = vi.mocked(recordImport);
const mockRecordPacks = vi.mocked(recordPacks);
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
    mockClaimPendingInvitesForUser.mockResolvedValue(true);
    mockStartInitialCloudSync.mockResolvedValue({
      personUid: "prs_1",
      handle: "h",
    });
    mockPersonalize.mockResolvedValue(undefined);
    // No default packs unless a test opts in — keeps the flow tests focused.
    // (clearAllMocks keeps implementations, so reset it explicitly each run.)
    mockGetDefaultPacks.mockReturnValue([]);
    mockRunExistingImport.mockResolvedValue({
      codexApplied: true,
      discoveryOk: true,
      claudeCounts: {},
      totalClaudeArtifacts: 0,
      scanDir: "workspace/imports/2026-06-18T12-34-56-000Z",
      issues: [],
    });
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

  // ── 2a. Company attachment via pending-invite claim (DEV-1733) ──────────
  //
  // Regression for feedback_1b3d52fa: a fresh install (reinstall on a new
  // machine) could NOT attach to a company without manual surgery, because the
  // personalize stage only called listUserCompanies — which returns nothing for
  // a user whose membership is still an email-keyed *pending invite*. The fix
  // claims pending invites BEFORE company detection so the invite becomes an
  // active membership the lookup can see.

  describe("pending-invite claim before company detection", () => {
    it("claims pending invites with the user's hints during personalize", async () => {
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      expect(mockClaimPendingInvitesForUser).toHaveBeenCalledTimes(1);
      expect(mockClaimPendingInvitesForUser).toHaveBeenCalledWith("at", {
        ownerSub: "sub-123",
        displayName: "Jane Doe",
      });
    });

    it("claims invites BEFORE listing companies (so the claim is visible)", async () => {
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      const claimOrder =
        mockClaimPendingInvitesForUser.mock.invocationCallOrder[0];
      const listOrder = mockListUserCompanies.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(listOrder);
    });

    it("attaches to a company that is only visible after the invite is claimed", async () => {
      // Simulate the post-claim world: the lookup now returns the company the
      // user was invited to. The install must attach (setTeam) and NOT fall
      // back to Personal HQ.
      mockListUserCompanies.mockResolvedValue([
        {
          companyUid: "cmp_acme",
          companySlug: "acme",
          companyName: "Acme Corp",
          bucketName: "hq-vault-acme",
          role: "member",
          status: "active",
        },
      ]);

      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      expect(mockClaimPendingInvitesForUser).toHaveBeenCalledTimes(1);
      expect(mockSetTeam).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "acme", companyId: "cmp_acme" }),
      );
      expect(mockSetIsPersonal).not.toHaveBeenCalled();
    });

    it("treats a claim failure as non-fatal — the install still completes", async () => {
      mockClaimPendingInvitesForUser.mockRejectedValueOnce(
        new Error("network unreachable"),
      );
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });
      // Detection still ran after the failed claim.
      expect(mockListUserCompanies).toHaveBeenCalled();
    });

    it("skips the claim when no user is signed in", async () => {
      // No user → the flow halts at git-init (needs identity), but the claim
      // must never be attempted without a signed-in user.
      mockGetCurrentUser.mockResolvedValue(null);
      const { container } = render(
        <SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />,
      );
      await waitFor(() => {
        const row = container.querySelector('[data-stage="git-init"]');
        expect(row?.getAttribute("data-status")).toBe("failed");
      });
      expect(mockClaimPendingInvitesForUser).not.toHaveBeenCalled();
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
        "initial-sync",
        "packages",
        "git-init",
        "personalize",
        "import",
        "indexing",
        "menubar",
      ]);
    });
  });

  // ── 4a. Initial cloud sync stage ─────────────────────────────────────────
  //
  // Provisions the personal vault + spawns the hq-cloud-sync runner right
  // after deps (earliest point node/npx exist), before packages. Best-effort:
  // a kickoff failure is journaled but never blocks the install — HQ Sync
  // re-runs the same sync on its first launch.

  describe("initial-sync stage", () => {
    it("kicks off the sync with install path, token, and person hints", async () => {
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      expect(mockStartInitialCloudSync).toHaveBeenCalledTimes(1);
      expect(mockStartInitialCloudSync).toHaveBeenCalledWith(
        "/tmp/hq",
        "at",
        { ownerSub: "sub-123", displayName: "Jane Doe" },
      );
    });

    it("runs after deps and before the packages stage", async () => {
      mockGetDefaultPacks.mockReturnValue([
        { name: "hq-pack-gstack", source: "@indigoai-us/hq-pack-gstack" },
      ]);
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      const depsOrder = mockRunDepsInstall.mock.invocationCallOrder[0];
      const syncOrder = mockStartInitialCloudSync.mock.invocationCallOrder[0];
      const packSpawn = mockInvoke.mock.calls.findIndex(
        ([cmd, payload]) =>
          cmd === "spawn_process" &&
          (payload as { args?: { cmd?: string } })?.args?.cmd === "hq",
      );
      const packOrder = mockInvoke.mock.invocationCallOrder[packSpawn];
      expect(depsOrder).toBeLessThan(syncOrder);
      expect(syncOrder).toBeLessThan(packOrder);
    });

    it("skips the kickoff (and still completes) when no user is signed in", async () => {
      // No user: initial-sync skips; the flow then halts at git-init (which
      // requires the identity) — but the sync stage itself must not be the
      // thing that fails, and no kickoff must have been attempted.
      mockGetCurrentUser.mockResolvedValue(null);
      const { container } = render(
        <SetupProgress installPath="/tmp/hq" onNext={vi.fn()} />,
      );
      await waitFor(() => {
        const row = container.querySelector('[data-stage="git-init"]');
        expect(row?.getAttribute("data-status")).toBe("failed");
      });
      expect(mockStartInitialCloudSync).not.toHaveBeenCalled();
      const syncRow = container.querySelector('[data-stage="initial-sync"]');
      expect(syncRow).toBeNull(); // not the active/failed stage
    });

    it("treats a kickoff failure as non-fatal — install completes, failure journaled", async () => {
      mockStartInitialCloudSync.mockRejectedValueOnce(
        new Error("422 ENTITY_NOT_PROVISIONED"),
      );
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      // Failure-ledger row written for a later /setup…
      expect(mockRecordStepFailure).toHaveBeenCalledWith(
        "/tmp/hq",
        expect.any(String),
        "initial-sync",
        expect.stringContaining("ENTITY_NOT_PROVISIONED"),
      );
      // …and the step still ends ok (the install was never blocked).
      expect(mockRecordStepOk).toHaveBeenCalledWith(
        "/tmp/hq",
        expect.any(String),
        "initial-sync",
      );
    });
  });

  // ── 4b. Merged import stage ─────────────────────────────────────────────

  describe("import stage", () => {
    it("runs after personalize and before indexing", async () => {
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      const personalizeOrder = mockPersonalize.mock.invocationCallOrder[0];
      const importOrder = mockRunExistingImport.mock.invocationCallOrder[0];
      const qmdSpawn = mockInvoke.mock.calls.findIndex(
        ([cmd, payload]) =>
          cmd === "spawn_process" &&
          (payload as { args?: { cmd?: string } })?.args?.cmd === "qmd",
      );
      const indexingOrder = mockInvoke.mock.invocationCallOrder[qmdSpawn];

      expect(personalizeOrder).toBeLessThan(importOrder);
      expect(importOrder).toBeLessThan(indexingOrder);
    });

    it("records the import summary in the install-manifest", async () => {
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      expect(mockRecordImport).toHaveBeenCalledWith(
        "/tmp/hq",
        expect.any(String),
        {
          codexApplied: true,
          discoveryOk: true,
          claudeCounts: {},
          totalClaudeArtifacts: 0,
        },
      );
    });

    it("treats import warnings as non-fatal — the install still completes", async () => {
      mockRunExistingImport.mockResolvedValueOnce({
        codexApplied: false,
        discoveryOk: false,
        claudeCounts: null,
        totalClaudeArtifacts: null,
        scanDir: "workspace/imports/2026-06-18T12-34-56-000Z",
        issues: ["Claude discovery did not complete."],
      });

      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      expect(mockRecordStepFailure).toHaveBeenCalledWith(
        "/tmp/hq",
        expect.any(String),
        "import",
        "Existing setup import completed with warnings.",
        expect.objectContaining({
          codexApplied: false,
          discoveryOk: false,
        }),
      );
      expect(mockRecordStepOk).toHaveBeenCalledWith(
        "/tmp/hq",
        expect.any(String),
        "import",
      );
    });
  });

  // ── 4c. Default-packs stage — installs recommended set, no picker ───────

  describe("packages stage", () => {
    const PACKS = [
      {
        name: "hq-pack-design-styles",
        source: "@indigoai-us/hq-pack-design-styles",
      },
      { name: "hq-pack-gstack", source: "@indigoai-us/hq-pack-gstack" },
    ];

    it("installs each default pack via `hq install <npm> --allow-hooks` (no picker, no npx)", async () => {
      mockGetDefaultPacks.mockReturnValue(PACKS);
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      for (const pack of PACKS) {
        expect(mockInvoke).toHaveBeenCalledWith("spawn_process", {
          args: {
            cmd: "hq",
            args: ["install", pack.source, "--allow-hooks"],
            cwd: "/tmp/hq",
          },
        });
      }
      // No npx indirection — the bug that broke the clean-room install.
      const npxCalls = mockInvoke.mock.calls.filter(
        ([cmd, payload]) =>
          cmd === "spawn_process" &&
          (payload as { args?: { cmd?: string } })?.args?.cmd === "npx",
      );
      expect(npxCalls.length).toBe(0);
    });

    it("records each pack's outcome in the install-manifest", async () => {
      mockGetDefaultPacks.mockReturnValue(PACKS);
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      expect(mockRecordPacks).toHaveBeenCalledWith(
        "/tmp/hq",
        expect.any(String),
        expect.objectContaining({
          "hq-pack-design-styles": { status: "ok" },
          "hq-pack-gstack": { status: "ok" },
        }),
      );
    });

    it("treats a failed pack as non-fatal — the install still completes", async () => {
      mockGetDefaultPacks.mockReturnValue(PACKS);
      // `hq` pack installs reject; the qmd indexing spawn still succeeds.
      let counter = 0;
      mockInvoke.mockImplementation(
        async (command: string, payload?: unknown): Promise<unknown> => {
          if (command === "git_init") {
            return "0123456789abcdef0123456789abcdef01234567";
          }
          if (command === "spawn_process") {
            const cmd = (payload as { args?: { cmd?: string } })?.args?.cmd;
            if (cmd === "hq") throw new Error("hq install failed");
            return `handle-${++counter}`;
          }
          if (command === "install_menubar_app") {
            return { success: true, appPath: "/x", error: null };
          }
          return undefined;
        },
      );

      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      // The run still reaches Done despite both packs failing.
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      expect(mockRecordPacks).toHaveBeenCalledWith(
        "/tmp/hq",
        expect.any(String),
        expect.objectContaining({
          "hq-pack-design-styles": expect.objectContaining({ status: "failed" }),
          "hq-pack-gstack": expect.objectContaining({ status: "failed" }),
        }),
      );
    });

    it("installs nothing (and records nothing) when there are no default packs", async () => {
      mockGetDefaultPacks.mockReturnValue([]);
      const onNext = vi.fn();
      render(<SetupProgress installPath="/tmp/hq" onNext={onNext} />);
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      const installCalls = mockInvoke.mock.calls.filter(
        ([cmd, payload]) =>
          cmd === "spawn_process" &&
          (payload as { args?: { cmd?: string } })?.args?.cmd === "hq",
      );
      expect(installCalls.length).toBe(0);
      expect(mockRecordPacks).not.toHaveBeenCalled();
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
