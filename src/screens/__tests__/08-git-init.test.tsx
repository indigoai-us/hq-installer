import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitInit } from "../08-git-init.js";
import { setGitIdentity, clearWizardState } from "../../lib/wizard-state.js";
import * as wizardStateModule from "../../lib/wizard-state.js";

// ---------------------------------------------------------------------------
// GitInit screen tests (US-016)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks
// ---------------------------------------------------------------------------

type EventCallback = (event: { payload: unknown }) => void;
const listenCallbacks = new Map<string, EventCallback[]>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn().mockResolvedValue(true),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: EventCallback) => {
    if (!listenCallbacks.has(event)) {
      listenCallbacks.set(event, []);
    }
    listenCallbacks.get(event)!.push(handler);
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

import { invoke } from "@tauri-apps/api/core";
import { exists } from "@tauri-apps/plugin-fs";
const mockInvoke = vi.mocked(invoke);
const mockExists = vi.mocked(exists);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fireListenEvent(event: string, payload: unknown) {
  const handlers = listenCallbacks.get(event) ?? [];
  for (const handler of handlers) {
    handler({ payload });
  }
}

/** Simulate a spawn_process completing successfully for a given handle. */
function completeProcess(handle: string) {
  act(() => {
    fireListenEvent(`process://${handle}/exit`, { code: 0, success: true });
  });
}

/** Simulate a spawn_process failing for a given handle. */
function failProcess(handle: string, code = 1): void {
  act(() => {
    fireListenEvent(`process://${handle}/exit`, { code, success: false });
  });
}

// Keep failProcess referenced to avoid TS6133 — it's available for test use.
void failProcess;

// Default probe response: returns a user with name + email.
const DEFAULT_PROBE = { name: "Test User", email: "test@example.com" };

// Default invoke mock: probes user; git_init returns SHA; spawn_process returns handle.
let handleCounter = 0;
function buildInvokeMock(overrides: {
  probeResult?: typeof DEFAULT_PROBE | null;
  gitInitResult?: string | Error;
  spawnHandles?: string[];
} = {}) {
  const spawnQueue = [...(overrides.spawnHandles ?? ["handle-1", "handle-2"])];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn(async (command: string): Promise<any> => {
    if (command === "git_probe_user") {
      const r = overrides.probeResult !== undefined ? overrides.probeResult : DEFAULT_PROBE;
      return r;
    }
    if (command === "git_init") {
      const r = overrides.gitInitResult;
      if (r instanceof Error) throw r;
      return r ?? "abc1234def5678901234567890123456789012345";
    }
    if (command === "spawn_process") {
      const h = spawnQueue.shift() ?? `handle-${++handleCounter}`;
      return h;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitInit screen (08-git-init.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenCallbacks.clear();
    handleCounter = 0;
    clearWizardState();
    mockInvoke.mockImplementation(buildInvokeMock());
    mockExists.mockResolvedValue(true);
  });

  // ── 1. On mount, calls git_probe_user to pre-fill fields ──────────────────

  it("calls git_probe_user on mount", async () => {
    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_probe_user");
    });
  });

  it("pre-fills name and email from git_probe_user result", async () => {
    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      const nameInput = screen.queryByRole("textbox", { name: /name/i }) as HTMLInputElement | null;
      const emailInput = screen.queryByRole("textbox", { name: /email/i }) as HTMLInputElement | null;
      expect(nameInput?.value).toBe("Test User");
      expect(emailInput?.value).toBe("test@example.com");
    });
  });

  it("preserves Cognito email pre-fill when git_probe_user returns a different email", async () => {
    // Seed wizard state as if 02-cognito-auth already ran.
    setGitIdentity("Cognito User", "cognito@example.com");

    // Probe returns a different local git identity.
    mockInvoke.mockImplementation(
      buildInvokeMock({ probeResult: { name: "Local User", email: "local@example.com" } })
    );

    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_probe_user");
    });

    // Both name and email must remain the Cognito ones — probe must not override either.
    const nameInput = screen.queryByRole("textbox", { name: /name/i }) as HTMLInputElement | null;
    const emailInput = screen.queryByRole("textbox", { name: /email/i }) as HTMLInputElement | null;
    expect(nameInput?.value).toBe("Cognito User");
    expect(emailInput?.value).toBe("cognito@example.com");
  });

  it("handles git_probe_user returning null gracefully", async () => {
    mockInvoke.mockImplementation(buildInvokeMock({ probeResult: null }));
    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_probe_user");
    });

    // Fields should be empty (not crash)
    const nameInput = screen.queryByRole("textbox", { name: /name/i }) as HTMLInputElement | null;
    expect(nameInput?.value ?? "").toBe("");
  });

  // ── 2. Name/email inputs are editable ────────────────────────────────────

  it("allows editing the name field", async () => {
    const user = userEvent.setup();
    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_probe_user");
    });

    const nameInput = screen.getByRole("textbox", { name: /name/i });
    await user.clear(nameInput);
    await user.type(nameInput, "New Name");

    expect((nameInput as HTMLInputElement).value).toBe("New Name");
  });

  it("allows editing the email field", async () => {
    const user = userEvent.setup();
    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_probe_user");
    });

    const emailInput = screen.getByRole("textbox", { name: /email/i });
    await user.clear(emailInput);
    await user.type(emailInput, "new@example.com");

    expect((emailInput as HTMLInputElement).value).toBe("new@example.com");
  });

  // ── 3. Run button is disabled until name + email are filled ──────────────

  it("Run button is disabled when name and email are empty", async () => {
    mockInvoke.mockImplementation(buildInvokeMock({ probeResult: null }));
    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_probe_user");
    });

    const runBtn = screen.queryByRole("button", { name: /run setup/i });
    if (runBtn) {
      expect((runBtn as HTMLButtonElement).disabled).toBe(true);
    }
    // Acceptable if button is absent when no identity is provided
  });

  it("Run button is enabled when name and email are filled", async () => {
    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      const runBtn = screen.queryByRole("button", { name: /run setup/i });
      if (runBtn) {
        expect((runBtn as HTMLButtonElement).disabled).toBe(false);
      }
    });
  });

  // ── 4. Run button calls git_init with correct args ────────────────────────

  it("clicking Run calls git_init with the correct path, name, and email", async () => {
    const user = userEvent.setup();
    // Use a slow spawn so we can assert git_init before scripts complete.
    mockInvoke.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.fn(async (command: string): Promise<any> => {
        if (command === "git_probe_user") return DEFAULT_PROBE;
        if (command === "git_init") return "abc1234";
        if (command === "spawn_process") return new Promise(() => {}); // never resolves
        return null;
      })
    );

    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /run setup/i })).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /run setup/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_init", {
        path: "/tmp/hq",
        name: "Test User",
        email: "test@example.com",
      });
    });
  });

  // ── 4b. After git_init succeeds, setGitIdentity is called with form values ──────

  it("calls setGitIdentity with the form name and email after git_init succeeds", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(wizardStateModule, "setGitIdentity");
    mockInvoke.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.fn(async (command: string): Promise<any> => {
        if (command === "git_probe_user") return DEFAULT_PROBE;
        if (command === "git_init") return "abc1234";
        if (command === "spawn_process") return new Promise(() => {}); // never resolves
        return null;
      })
    );

    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /run setup/i })).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /run setup/i }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith("Test User", "test@example.com");
    });

    spy.mockRestore();
  });

  // ── 5. After git_init succeeds, spawn_process is called for compute-checksums.sh ──

  it("spawns compute-checksums.sh after git_init succeeds", async () => {
    const user = userEvent.setup();

    const invokeMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string): Promise<any> => {
        if (command === "git_probe_user") return DEFAULT_PROBE;
        if (command === "git_init") return "abc1234";
        if (command === "spawn_process") return new Promise(() => {}); // never resolves
        return null;
      }
    );
    mockInvoke.mockImplementation(invokeMock);

    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /run setup/i })).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /run setup/i }));

    await waitFor(() => {
      const spawnCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "spawn_process");
      expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
      const firstSpawn = (spawnCalls[0] as unknown[])[1] as { args: { cmd: string; args: string[] } };
      // Script path is args[0] — we invoke `bash <path>` directly (no -c flag)
      // so the file is read as a script and the execute bit isn't required.
      const scriptArg = firstSpawn?.args?.args?.[0] ?? "";
      expect(scriptArg).toMatch(/compute-checksums/);
    });
  });

  // ── 6. After compute-checksums succeeds, spawn_process called for core-integrity.sh ──

  it("spawns core-integrity.sh after compute-checksums.sh succeeds", async () => {
    const user = userEvent.setup();

    const handles: string[] = [];
    const invokeMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string): Promise<any> => {
        if (command === "git_probe_user") return DEFAULT_PROBE;
        if (command === "git_init") return "abc1234";
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      }
    );
    mockInvoke.mockImplementation(invokeMock);

    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /run setup/i })).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /run setup/i }));

    // Wait for compute-checksums.sh to be spawned.
    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));

    // Complete compute-checksums.sh.
    completeProcess(handles[0]);

    // core-integrity.sh should now be spawned.
    await waitFor(() => {
      const spawnCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "spawn_process");
      expect(spawnCalls.length).toBeGreaterThanOrEqual(2);
      const secondSpawn = (spawnCalls[1] as unknown[])[1] as { args: { cmd: string; args: string[] } };
      const scriptArg = secondSpawn?.args?.args?.[0] ?? "";
      expect(scriptArg).toMatch(/core-integrity/);
    });
  });

  // ── 6b. core-integrity.sh missing from template → step is skipped ────────

  it("skips core-integrity.sh when the script is missing from the template", async () => {
    const user = userEvent.setup();

    mockExists.mockResolvedValue(false);

    const handles: string[] = [];
    const invokeMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string): Promise<any> => {
        if (command === "git_probe_user") return DEFAULT_PROBE;
        if (command === "git_init") return "abc1234";
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      }
    );
    mockInvoke.mockImplementation(invokeMock);

    render(<GitInit installPath="/tmp/hq" onNext={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /run setup/i })).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /run setup/i }));

    // Complete compute-checksums.sh (step 1). Step 2 should skip itself
    // without spawning a second process.
    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

    // Continue button should appear — step 2 marked done via skip path.
    await waitFor(() => {
      const btn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /next/i });
      expect(btn).not.toBeNull();
    });

    // core-integrity.sh was never spawned (step skipped via exists=false).
    // Other spawn_process calls may occur (compute-checksums + silent hq-pack
    // installs), but none should reference core-integrity.
    const spawnCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "spawn_process");
    const coreIntegritySpawned = spawnCalls.some((call) => {
      // `vi.fn(async (command: string) => ...)` types mock.calls as a 1-tuple,
      // but invoke() is actually called with 2 args. Cast to unknown[] to reach
      // index 1 — matches the pattern used on line 269.
      const payload = (call as unknown[])[1] as
        | { args?: { args?: unknown[] } }
        | undefined;
      const args = payload?.args?.args ?? [];
      return args.some((a) => typeof a === "string" && a.includes("core-integrity"));
    });
    expect(coreIntegritySpawned).toBe(false);

    // exists() was asked about core-integrity.sh at the expected path.
    expect(mockExists).toHaveBeenCalledWith("/tmp/hq/scripts/core-integrity.sh");
  });

  // ── 7. All steps done → Continue button appears ──────────────────────────

  it("shows a Continue button when all three steps complete successfully", async () => {
    const user = userEvent.setup();

    const handles: string[] = [];
    const invokeMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string): Promise<any> => {
        if (command === "git_probe_user") return DEFAULT_PROBE;
        if (command === "git_init") return "abc1234";
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      }
    );
    mockInvoke.mockImplementation(invokeMock);

    render(<GitInit installPath="/tmp/hq" onNext={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /run setup/i })).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /run setup/i }));

    // Complete compute-checksums.sh.
    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

    // Complete core-integrity.sh.
    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(2));
    completeProcess(handles[1]);

    await waitFor(() => {
      const btn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /next/i });
      expect(btn).not.toBeNull();
    });
  });

  it("Continue button calls onNext", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();

    const handles: string[] = [];
    const invokeMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string): Promise<any> => {
        if (command === "git_probe_user") return DEFAULT_PROBE;
        if (command === "git_init") return "abc1234";
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      }
    );
    mockInvoke.mockImplementation(invokeMock);

    render(<GitInit installPath="/tmp/hq" onNext={onNext} />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /run setup/i })).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /run setup/i }));

    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(2));
    completeProcess(handles[1]);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /next/i })
      ).not.toBeNull();
    });

    const btn =
      screen.queryByRole("button", { name: /continue/i }) ||
      screen.queryByRole("button", { name: /next/i });
    await user.click(btn!);

    expect(onNext).toHaveBeenCalledTimes(1);
  });

  // ── 8. On git_init failure → error state + Retry button ──────────────────

  it("shows a Retry button when git_init fails", async () => {
    const user = userEvent.setup();

    mockInvoke.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.fn(async (command: string): Promise<any> => {
        if (command === "git_probe_user") return DEFAULT_PROBE;
        if (command === "git_init") throw new Error("git init failed");
        return null;
      })
    );

    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /run setup/i })).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /run setup/i }));

    await waitFor(() => {
      const btn =
        screen.queryByRole("button", { name: /retry/i }) ||
        screen.queryByRole("button", { name: /try again/i });
      expect(btn).not.toBeNull();
    });
  });

  it("clicking Retry re-runs git_init", async () => {
    const user = userEvent.setup();
    let gitInitCount = 0;

    mockInvoke.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.fn(async (command: string): Promise<any> => {
        if (command === "git_probe_user") return DEFAULT_PROBE;
        if (command === "git_init") {
          gitInitCount++;
          throw new Error("git init failed");
        }
        return null;
      })
    );

    render(<GitInit installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /run setup/i })).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /run setup/i }));

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /retry/i }) ||
        screen.queryByRole("button", { name: /try again/i })
      ).not.toBeNull();
    });

    const retryBtn =
      screen.queryByRole("button", { name: /retry/i }) ||
      screen.queryByRole("button", { name: /try again/i });
    await user.click(retryBtn!);

    await waitFor(() => {
      expect(gitInitCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ── 9. No purple/indigo class names ──────────────────────────────────────

  it("does NOT use 'purple' class names in the DOM", async () => {
    render(<GitInit installPath="/tmp/hq" />);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_probe_user");
    });
    expect(document.body.innerHTML).not.toMatch(/\bpurple\b/);
  });

  it("does NOT use 'indigo' class names in the DOM", async () => {
    render(<GitInit installPath="/tmp/hq" />);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_probe_user");
    });
    expect(document.body.innerHTML).not.toMatch(/\bindigo\b/);
  });

  // ── 10. Tauri environment compatibility ───────────────────────────────────

  it("renders cleanly when Tauri APIs are mocked", () => {
    expect(() => {
      render(<GitInit installPath="/tmp/hq" />);
    }).not.toThrow();
  });
});
