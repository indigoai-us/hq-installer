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

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  });

  // ── 1. Tauri environment compatibility ────────────────────────────────────

  it("renders cleanly when Tauri APIs are mocked", () => {
    expect(() => {
      render(<QmdIndexing installPath="/tmp/hq" />);
    }).not.toThrow();
  });

  // ── 2. Auto-starts on mount ───────────────────────────────────────────────

  it("auto-starts on mount — calls invoke('spawn_process') with qmd index args", async () => {
    render(<QmdIndexing installPath="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("spawn_process", {
        args: { cmd: "qmd", args: ["index", "."], cwd: "/tmp/hq" },
      });
    });
  });

  it("spawns qmd embed after qmd index succeeds", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // Complete step 0 (qmd index .)
    completeProcess(handles[0]);

    // Step 1 (qmd embed) should now be spawned.
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("spawn_process", {
        args: { cmd: "qmd", args: ["embed"], cwd: "/tmp/hq" },
      });
    });
  });

  // ── 3. Shows "Running" status while steps are in progress ─────────────────

  it("shows 'Running' status text while step 0 is in progress", async () => {
    // spawn_process never resolves — keeps step 0 in running state indefinitely.
    mockInvoke.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  it("shows 'Continue' button when both steps complete successfully", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // Complete step 0.
    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

    // Complete step 1.
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
    mockInvoke.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // ── 5. Shows "Retry" button when a step fails ─────────────────────────────

  it("shows 'Retry' button when step 0 exits with failure", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  it("shows 'Retry' button when step 1 exits with failure", async () => {
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // Complete step 0.
    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(1));
    completeProcess(handles[0]);

    // Wait for step 1 to be spawned, then fail it.
    await waitFor(() => expect(handles.length).toBeGreaterThanOrEqual(2));
    failProcess(handles[1]);

    await waitFor(() => {
      const btn = screen.queryByRole("button", { name: /retry/i });
      expect(btn).not.toBeNull();
    });
  });

  it("Retry button re-spawns from the failed step", async () => {
    const user = userEvent.setup();
    const handles: string[] = [];
    mockInvoke.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // ── 6. No purple/indigo class names in DOM ────────────────────────────────

  it("does NOT use 'purple' class names in the DOM", () => {
    const { container } = render(<QmdIndexing installPath="/tmp/hq" />);
    expect(container.innerHTML).not.toMatch(/\bpurple\b/);
  });

  it("does NOT use 'indigo' class names in the DOM", () => {
    const { container } = render(<QmdIndexing installPath="/tmp/hq" />);
    expect(container.innerHTML).not.toMatch(/\bindigo\b/);
  });
});
