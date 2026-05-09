import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QmdIndexing } from "../10-indexing.js";

// ---------------------------------------------------------------------------
// QmdIndexing screen tests (US-018)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks
// ---------------------------------------------------------------------------

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

// The Verify step writes a post-install marker via @tauri-apps/plugin-fs.
// Mock writeTextFile + mkdir so tests can assert the marker write without a
// real filesystem, and so we can force the primary write to fail when
// exercising the ~/.hq/embeddings-pending.json fallback.
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(false),
  readTextFile: vi.fn().mockResolvedValue("{}"),
  BaseDirectory: { Home: "Home" },
}));

import { invoke } from "@tauri-apps/api/core";
import { writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
const mockInvoke = vi.mocked(invoke);
const mockWriteTextFile = vi.mocked(writeTextFile);
const mockMkdir = vi.mocked(mkdir);

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
function failProcess(handle: string, code = 1) {
  act(() => {
    fireListenEvent(`process://${handle}/exit`, { code, success: false });
  });
}

// Keep failProcess referenced to avoid TS6133.
void failProcess;

let handleCounter = 0;

/**
 * Build a mock invoke that:
 *  - returns sequential handles for spawn_process
 *  - can be overridden per-command
 */
function buildInvokeMock(opts: { spawnHandles?: string[] } = {}) {
  const spawnQueue = [...(opts.spawnHandles ?? [])];
  return vi.fn(async (command: string): Promise<any> => {
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

describe("QmdIndexing screen (10-indexing.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenCallbacks.clear();
    handleCounter = 0;
    mockInvoke.mockImplementation(buildInvokeMock());
    // Reset the fs mocks to their default success state each test; individual
    // cases can override (e.g. force the primary write to reject).
    mockWriteTextFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  // ── 1. Tauri environment compatibility ────────────────────────────────────

  it("renders cleanly when Tauri APIs are mocked", () => {
    expect(() => {
      render(<QmdIndexing installPath="/tmp/hq" />);
    }).not.toThrow();
  });

  // ── 2. Auto-starts on mount ───────────────────────────────────────────────

  it("auto-starts on mount — calls invoke('spawn_process') with qmd collection-add args", async () => {
    render(<QmdIndexing installPath="/tmp/hq" />);

    // qmd 2.x: first step is `qmd collection add . --name <slug>` where slug
    // is the basename of installPath. "/tmp/hq" → "hq".
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("spawn_process", {
        args: {
          cmd: "qmd",
          args: ["collection", "add", ".", "--name", "hq"],
          cwd: "/tmp/hq",
        },
      });
    });
  });

  it("falls back to 'qmd update' when collection already exists", async () => {
    // Simulate the qmd 2.x "already exists" error on the first spawn, so the
    // component should transparently retry as `qmd update --name <slug>`.
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      })
    );

    render(<QmdIndexing installPath="/tmp/hq" />);

    // Wait for step 0 (collection add) to spawn.
    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));

    // Emit an "already exists" stderr line, then fail the process.
    act(() => {
      fireListenEvent(`process://${handles[0]}/stderr`, {
        line: "Collection 'hq' already exists. Use a different name with --name <name>",
      });
    });
    failProcess(handles[0]);

    // Component should retry as `qmd update --name hq` instead of surfacing
    // the failure to the user.
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("spawn_process", {
        args: {
          cmd: "qmd",
          args: ["update", "--name", "hq"],
          cwd: "/tmp/hq",
        },
      });
    });

    // No Retry button should be visible during the transparent fallback.
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("does NOT spawn `qmd embed` — embeddings are now deferred to hq-sync", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      })
    );

    render(<QmdIndexing installPath="/tmp/hq" />);

    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

    // Wait for the marker write to settle, then assert no spawn_process call
    // ever invoked `qmd embed` (neither directly nor via `sh -c`).
    await waitFor(() => expect(mockWriteTextFile).toHaveBeenCalled());

    const embedCalls = mockInvoke.mock.calls.filter(([cmd, payload]) => {
      if (cmd !== "spawn_process") return false;
      const args = (payload as { args?: { cmd?: string; args?: string[] } })
        ?.args;
      const argv = [args?.cmd ?? "", ...(args?.args ?? [])].join(" ");
      return /\bqmd\s+embed\b/.test(argv);
    });
    expect(embedCalls).toHaveLength(0);
  });

  // ── 3. Shows "Running" status while steps are in progress ─────────────────

  it("shows 'Running' status text while step 0 is in progress", async () => {
    // spawn_process never resolves — keeps step 0 in running state indefinitely.
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") return new Promise(() => {});
        return null;
      })
    );

    render(<QmdIndexing installPath="/tmp/hq" />);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/running/i);
    });
  });

  // ── 4. Shows "Continue" button when both steps complete ───────────────────

  it("shows 'Continue' as soon as step 0 completes", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      })
    );

    render(<QmdIndexing installPath="/tmp/hq" onNext={vi.fn()} />);

    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

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
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      })
    );

    render(<QmdIndexing installPath="/tmp/hq" onNext={onNext} />);

    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

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

  // ── 5. Shows "Retry" button when a step fails ─────────────────────────────

  it("shows 'Retry' button when step 0 exits with failure", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      })
    );

    render(<QmdIndexing installPath="/tmp/hq" />);

    // Wait for step 0 to be spawned.
    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));

    // Fail step 0.
    failProcess(handles[0]);

    await waitFor(() => {
      const btn = screen.queryByRole("button", { name: /retry/i });
      expect(btn).not.toBeNull();
    });
  });

  // ── Pending marker (US-001) ───────────────────────────────────────────────

  it("writes {installPath}/.hq-embeddings-pending.json on step 0 success", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      })
    );

    render(<QmdIndexing installPath="/Users/jane/hq" />);

    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

    await waitFor(() =>
      expect(
        mockWriteTextFile.mock.calls.some(([p]) =>
          String(p).includes(".hq-embeddings-pending.json")
        )
      ).toBe(true)
    );

    // Find the embeddings-pending write (manifest writes also go through
    // writeTextFile, so we filter by path rather than using call index).
    const markerCall = mockWriteTextFile.mock.calls.find(([p]) =>
      String(p).includes(".hq-embeddings-pending.json")
    )!;
    const [markerPath, markerPayload, markerOpts] = markerCall;
    expect(markerPath).toBe("/Users/jane/hq/.hq-embeddings-pending.json");
    expect(markerOpts).toBeUndefined();

    const parsed = JSON.parse(markerPayload as string);
    expect(parsed.reason).toBe("post-install");
    expect(typeof parsed.requestedAt).toBe("string");
    // requestedAt must be a valid ISO8601 timestamp.
    expect(Number.isNaN(Date.parse(parsed.requestedAt))).toBe(false);
    expect(parsed.requestedAt).toMatch(/\dT\d.*Z$/);
  });

  it("falls back to ~/.hq/embeddings-pending.json when primary write fails", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      })
    );

    // The primary embeddings-pending write (absolute path) should reject so
    // the fallback (baseDir: Home) fires. Manifest writes to
    // install-manifest.json should succeed normally.
    mockWriteTextFile.mockReset();
    mockWriteTextFile.mockImplementation(async (path: string | URL) => {
      if (String(path).includes(".hq-embeddings-pending.json")) {
        throw new Error("EACCES: permission denied");
      }
    });

    render(<QmdIndexing installPath="/Users/jane/hq" />);

    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

    // Wait for the fallback write (baseDir: "Home") to appear among all
    // writeTextFile calls. Manifest writes also use writeTextFile but
    // target the install-manifest.json path without baseDir.
    await waitFor(() =>
      expect(
        mockWriteTextFile.mock.calls.some(
          ([p, , opts]) =>
            String(p) === ".hq/embeddings-pending.json" &&
            (opts as any)?.baseDir === "Home"
        )
      ).toBe(true)
    );

    // Ensure ~/.hq was created (recursive) before the fallback write.
    expect(mockMkdir).toHaveBeenCalledWith(".hq", {
      baseDir: "Home",
      recursive: true,
    });
  });

  it("skips the primary write entirely when installPath is not absolute", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      })
    );

    render(<QmdIndexing installPath="" />);

    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

    // Wait for the fallback write to appear among all writeTextFile calls.
    // Manifest writes also go through writeTextFile, so we can't assert on
    // total call count — filter for the embeddings-pending marker instead.
    await waitFor(() =>
      expect(
        mockWriteTextFile.mock.calls.some(([p]) =>
          String(p) === ".hq/embeddings-pending.json"
        )
      ).toBe(true)
    );

    // No primary (absolute-path) embeddings marker write should exist.
    const primaryCalls = mockWriteTextFile.mock.calls.filter(([p]) =>
      String(p).includes(".hq-embeddings-pending.json")
    );
    expect(primaryCalls).toHaveLength(0);

    // The fallback must target ~/.hq via baseDir.
    const fallbackCall = mockWriteTextFile.mock.calls.find(
      ([p, , opts]) =>
        String(p) === ".hq/embeddings-pending.json" &&
        (opts as any)?.baseDir === "Home"
    );
    expect(fallbackCall).toBeDefined();
  });

  // ── Deprecated UI affordances removed (US-001) ────────────────────────────

  it("does NOT render a 'Skip embeddings' button or 'several minutes' warning", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      })
    );

    render(<QmdIndexing installPath="/tmp/hq" />);

    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /continue/i })
      ).not.toBeNull();
    });

    // Neither the legacy Skip button nor the old "several minutes" warning
    // should be present in the DOM — embeddings are now sync's problem.
    expect(
      screen.queryByRole("button", { name: /skip embeddings/i })
    ).toBeNull();
    expect(document.body.textContent).not.toMatch(/several minutes/i);
  });

  it("Retry button re-spawns from the failed step", async () => {
    const user = userEvent.setup();
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      })
    );

    render(<QmdIndexing installPath="/tmp/hq" />);

    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    failProcess(handles[0]);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeNull();
    });

    const retryBtn = screen.getByRole("button", { name: /retry/i });
    const spawnCountBefore = handles.length;
    await user.click(retryBtn);

    // Clicking Retry must trigger at least one more spawn_process call.
    await waitFor(() => {
      expect(handles.length).toBeGreaterThan(spawnCountBefore);
    });
  });

  // ── 6. ABI-mismatch diagnostic ───────────────────────────────────────────

  it("shows ABI-mismatch remediation hint when ERR_DLOPEN_FAILED appears in stderr", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      vi.fn(async (command: string): Promise<any> => {
        if (command === "spawn_process") {
          const h = `handle-${handles.length + 1}`;
          handles.push(h);
          return h;
        }
        return null;
      })
    );

    render(<QmdIndexing installPath="/tmp/hq" />);

    // Wait for step 0 to be spawned.
    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));

    // Emit an ERR_DLOPEN_FAILED stderr line, then fail the process.
    act(() => {
      fireListenEvent(`process://${handles[0]}/stderr`, {
        line: "Error: The module '...better_sqlite3.node' ... NODE_MODULE_VERSION 137 ... code: 'ERR_DLOPEN_FAILED'",
      });
    });
    failProcess(handles[0]);

    // The displayed error must contain the remediation hint, not just an exit code.
    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/reinstall qmd/i);
    });
  });

  // ── 7. No purple/indigo class names in DOM ────────────────────────────────

  it("does NOT use 'purple' class names in the DOM", () => {
    const { container } = render(<QmdIndexing installPath="/tmp/hq" />);
    expect(container.innerHTML).not.toMatch(/\bpurple\b/);
  });

  it("does NOT use 'indigo' class names in the DOM", () => {
    const { container } = render(<QmdIndexing installPath="/tmp/hq" />);
    expect(container.innerHTML).not.toMatch(/\bindigo\b/);
  });
});
