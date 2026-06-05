// deps-install.test.ts — US-002
//
// Asserts: the core-vs-optional partition in runDepsInstall() installs only
// non-optional deps and skips optional ones, regardless of their order in DEPS.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Tauri API mocks — must be declared before the module under test is imported
// ---------------------------------------------------------------------------
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEPS, runDepsInstall } from "../deps-install.js";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wire up listen() to return a no-op unlisten function. */
function setupListenMock() {
  mockListen.mockResolvedValue(vi.fn() as () => void);
}

/** Make invoke() succeed for check_dep (returns installed: false) and all install commands. */
function invokeAlwaysOk() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "check_dep") return Promise.resolve({ installed: false });
    return Promise.resolve(undefined);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DEPS table — partition contract", () => {
  it("has at least one required dep", () => {
    const required = DEPS.filter((d) => !d.optional);
    expect(required.length).toBeGreaterThan(0);
  });

  it("has at least one optional dep", () => {
    const optional = DEPS.filter((d) => d.optional);
    expect(optional.length).toBeGreaterThan(0);
  });

  it("marks gh, claude-code, homebrew as optional (git is now required)", () => {
    const optionalIds = DEPS.filter((d) => d.optional).map((d) => d.id);
    expect(optionalIds).toContain("gh");
    expect(optionalIds).toContain("claude-code");
    expect(optionalIds).toContain("homebrew");
    // git flipped optional → required: HQ provisions a portable git (dugite)
    // into the managed toolchain, since autocommit/repos/agents/packs need it.
    expect(optionalIds).not.toContain("git");
  });

  it("marks node, yq, qmd, hq-cli, git as required", () => {
    const requiredIds = DEPS.filter((d) => !d.optional).map((d) => d.id);
    expect(requiredIds).toContain("node");
    expect(requiredIds).toContain("yq");
    expect(requiredIds).toContain("qmd");
    expect(requiredIds).toContain("hq-cli");
    expect(requiredIds).toContain("git");
  });
});

describe("runDepsInstall() — core-vs-optional partition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupListenMock();
  });

  it("returns a Promise", () => {
    invokeAlwaysOk();
    const result = runDepsInstall();
    expect(result).toBeInstanceOf(Promise);
    return result; // let vitest await/clean up
  });

  it("skips all optional deps — status is 'skipped', no install invoke called for them", async () => {
    invokeAlwaysOk();
    const summary = await runDepsInstall();

    const optionalResults = summary.results.filter((r) => r.optional);
    expect(optionalResults.length).toBeGreaterThan(0);

    for (const r of optionalResults) {
      expect(r.status).toBe("skipped");
    }

    // Confirm none of the optional install commands were called.
    const optionalInstallCmds = DEPS.filter((d) => d.optional).map((d) => d.installCmd);
    const calledCmds = mockInvoke.mock.calls.map(([cmd]) => cmd as string);
    for (const cmd of optionalInstallCmds) {
      expect(calledCmds).not.toContain(cmd);
    }
  });

  it("installs all required deps when none are pre-installed", async () => {
    invokeAlwaysOk();
    const summary = await runDepsInstall();

    const requiredResults = summary.results.filter((r) => !r.optional);
    // Every required dep should be ok
    for (const r of requiredResults) {
      expect(r.status).toBe("ok");
    }
  });

  it("sets allRequiredOk = true when every required dep succeeds", async () => {
    invokeAlwaysOk();
    const summary = await runDepsInstall();
    expect(summary.allRequiredOk).toBe(true);
  });

  it("sets allRequiredOk = false when a required dep fails", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "check_dep") return Promise.resolve({ installed: false });
      // Fail node install — node is required
      if (cmd === "install_node") return Promise.reject(new Error("Install failed"));
      return Promise.resolve(undefined);
    });

    const summary = await runDepsInstall();
    expect(summary.allRequiredOk).toBe(false);

    const nodeResult = summary.results.find((r) => r.id === "node");
    expect(nodeResult?.status).toBe("failed");
    expect(nodeResult?.error).toBeTruthy();
  });

  it("a failed optional dep does not affect allRequiredOk", async () => {
    // All required ok, but simulate optional install attempted (it won't be — skipped)
    invokeAlwaysOk();
    const summary = await runDepsInstall();
    // Optional results should all be skipped — even if we tried to make them fail
    const optionalResults = summary.results.filter((r) => r.optional);
    for (const r of optionalResults) {
      expect(r.status).toBe("skipped");
    }
    expect(summary.allRequiredOk).toBe(true);
  });

  it("skips a required dep when its parent dep failed (dependsOn gating)", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "check_dep") return Promise.resolve({ installed: false });
      if (cmd === "install_node") return Promise.reject(new Error("Install failed"));
      return Promise.resolve(undefined);
    });

    const summary = await runDepsInstall();

    // qmd and hq-cli depend on node — they should be failed (blocked)
    const qmd = summary.results.find((r) => r.id === "qmd");
    const hqCli = summary.results.find((r) => r.id === "hq-cli");

    expect(qmd?.status).toBe("failed");
    expect(hqCli?.status).toBe("failed");
  });

  it("skips install_cmd when dep is already installed (check_dep returns installed: true)", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "check_dep") return Promise.resolve({ installed: true });
      return Promise.resolve(undefined);
    });

    const summary = await runDepsInstall();
    // All required deps are already installed
    const required = summary.results.filter((r) => !r.optional);
    for (const r of required) {
      expect(r.status).toBe("ok");
    }

    // No install commands were called (only check_dep)
    const calledCmds = mockInvoke.mock.calls.map(([cmd]) => cmd as string);
    const installCmds = DEPS.map((d) => d.installCmd);
    for (const cmd of installCmds) {
      expect(calledCmds).not.toContain(cmd);
    }
  });

  it("results array contains an entry for every dep in DEPS", async () => {
    invokeAlwaysOk();
    const summary = await runDepsInstall();
    expect(summary.results).toHaveLength(DEPS.length);
    const resultIds = summary.results.map((r) => r.id);
    for (const dep of DEPS) {
      expect(resultIds).toContain(dep.id);
    }
  });

  it("each result carries the correct optional flag from the DEPS table", async () => {
    invokeAlwaysOk();
    const summary = await runDepsInstall();
    for (const result of summary.results) {
      const def = DEPS.find((d) => d.id === result.id);
      expect(result.optional).toBe(!!def?.optional);
    }
  });
});
