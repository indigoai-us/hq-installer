import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TemplateFetch } from "../07-template.js";

// ---------------------------------------------------------------------------
// TemplateFetch screen tests (US-016)
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

function fireEvent(event: string, payload: unknown) {
  const handlers = listenCallbacks.get(event) ?? [];
  for (const handler of handlers) {
    handler({ payload });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TemplateFetch screen (07-template.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenCallbacks.clear();
    // Default: fetch_template resolves successfully.
    mockInvoke.mockResolvedValue(undefined);
  });

  // ── 1. Initial render shows loading/progress state ────────────────────────

  it("shows a progress/loading state on initial render", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      // Must show some indication of activity
      expect(
        text.match(/download|fetch|progress|starting|loading/i) !== null ||
        document.querySelector("[role='progressbar']") !== null
      ).toBe(true);
    });
  });

  it("calls fetch_template on mount", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "fetch_template",
        expect.objectContaining({ targetDir: "/tmp/hq" })
      );
    });
  });

  it("registers a listener for template:progress on mount", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const mockListen = vi.mocked(listen);

    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      const registered = mockListen.mock.calls.some(
        ([event]) => event === "template:progress"
      );
      expect(registered).toBe(true);
    });
  });

  // ── 2. Progress events update the display ─────────────────────────────────

  it("updates progress display when template:progress events arrive", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("fetch_template", expect.anything());
    });

    act(() => {
      fireEvent("template:progress", {
        downloaded: 512 * 1024,
        total: 2 * 1024 * 1024,
        done: false,
      });
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      // Should show some kind of size/progress info
      expect(text.match(/\d+(\.\d+)?\s*(kb|mb|b)/i) !== null).toBe(true);
    });
  });

  // ── 3. On done, Continue button appears ───────────────────────────────────

  it("shows a Continue button when template:progress done:true is received", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" onNext={vi.fn()} />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("fetch_template", expect.anything());
    });

    act(() => {
      fireEvent("template:progress", {
        downloaded: 1024,
        total: 1024,
        done: true,
      });
    });

    await waitFor(() => {
      const btn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /next/i });
      expect(btn).not.toBeNull();
    });
  });

  it("clicking Continue calls onNext", async () => {
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<TemplateFetch targetDir="/tmp/hq" onNext={onNext} />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("fetch_template", expect.anything());
    });

    act(() => {
      fireEvent("template:progress", { downloaded: 1024, total: 1024, done: true });
    });

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

  // ── 4. On error, Retry button appears ────────────────────────────────────

  it("shows a Retry button when template:progress has an error", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("fetch_template", expect.anything());
    });

    act(() => {
      fireEvent("template:progress", {
        downloaded: 0,
        total: null,
        done: true,
        error: "Network error",
      });
    });

    await waitFor(() => {
      const btn =
        screen.queryByRole("button", { name: /retry/i }) ||
        screen.queryByRole("button", { name: /try again/i });
      expect(btn).not.toBeNull();
    });
  });

  it("shows a View log button on error", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("fetch_template", expect.anything());
    });

    act(() => {
      fireEvent("template:progress", {
        downloaded: 0,
        total: null,
        done: true,
        error: "Network error",
      });
    });

    await waitFor(() => {
      const btn =
        screen.queryByRole("button", { name: /view log/i }) ||
        screen.queryByRole("button", { name: /log/i });
      expect(btn).not.toBeNull();
    });
  });

  // ── 5. Retry re-invokes fetch_template ────────────────────────────────────

  it("clicking Retry re-invokes fetch_template", async () => {
    const user = userEvent.setup();
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("fetch_template", expect.anything());
    });

    act(() => {
      fireEvent("template:progress", {
        downloaded: 0,
        total: null,
        done: true,
        error: "Network error",
      });
    });

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
      const fetchCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "fetch_template");
      expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── 6. No purple/indigo class names ──────────────────────────────────────

  it("does NOT use 'purple' class names in the DOM", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("fetch_template", expect.anything());
    });
    expect(document.body.innerHTML).not.toMatch(/\bpurple\b/);
  });

  it("does NOT use 'indigo' class names in the DOM", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("fetch_template", expect.anything());
    });
    expect(document.body.innerHTML).not.toMatch(/\bindigo\b/);
  });

  // ── 7. Tauri environment compatibility ────────────────────────────────────

  it("renders without errors when Tauri APIs are mocked", () => {
    expect(() => {
      render(<TemplateFetch targetDir="/tmp/hq" />);
    }).not.toThrow();
  });
});
