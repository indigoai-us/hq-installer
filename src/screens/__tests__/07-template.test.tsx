import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// TemplateFetch screen tests (US-016)
//
// The screen calls `fetchAndExtract` from `@/lib/template-fetcher` — a pure
// TS helper that goes through `@tauri-apps/plugin-http` and `plugin-fs`,
// bypassing the old Rust `fetch_template` curl command entirely. These tests
// mock the helper so we can drive progress and resolution from the test
// body without touching the network or filesystem.
// ---------------------------------------------------------------------------

interface FetchCall {
  targetDir: string;
  tag: string | undefined;
  onProgress?: (event: { bytes: number; total: number }) => void;
  signal?: AbortSignal;
  resolve: (value: { version: string }) => void;
  reject: (err: unknown) => void;
}

const fetchCalls: FetchCall[] = [];

// `vi.mock` factories are hoisted to the top of the file, so the factory
// cannot reference outer identifiers. Everything it needs — the error class
// and the fetchCalls push — is referenced through `globalThis` so the
// hoisted factory can still reach it once the module body runs.
//
// `fetchCalls` is a top-level array in the module scope; the factory calls
// a getter that reaches back into it at invocation time (not hoist time).
vi.mock("@/lib/template-fetcher", () => {
  class TemplateFetchErrorMock extends Error {
    public readonly retriable: boolean;
    public readonly cause?: unknown;
    constructor(message: string, retriable: boolean, cause?: unknown) {
      super(message);
      this.name = "TemplateFetchError";
      this.retriable = retriable;
      this.cause = cause;
    }
  }
  return {
    TemplateFetchError: TemplateFetchErrorMock,
    fetchAndExtract: vi.fn(
      (
        targetDir: string,
        tag: string | undefined,
        onProgress?: (event: { bytes: number; total: number }) => void,
        signal?: AbortSignal,
      ) => {
        let resolve!: (value: { version: string }) => void;
        let reject!: (err: unknown) => void;
        const promise = new Promise<{ version: string }>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        // Reach back to the module-scope array at call time (lazy).
        (globalThis as { __fetchCalls?: FetchCall[] }).__fetchCalls!.push({
          targetDir,
          tag,
          onProgress,
          signal,
          resolve,
          reject,
        });
        return promise;
      },
    ),
  };
});

// Mock the Tauri core `invoke` too so we can prove the component never falls
// back to the legacy `fetch_template` command (guard against regression).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

// Bridge: expose fetchCalls via globalThis so the hoisted factory can reach it.
(globalThis as { __fetchCalls?: FetchCall[] }).__fetchCalls = fetchCalls;

// Import AFTER vi.mock so the component picks up the mocked helper.
import { TemplateFetch } from "../07-template.js";
import * as fetcher from "@/lib/template-fetcher";
const mockFetchAndExtract = vi.mocked(fetcher.fetchAndExtract);
// Grab the mocked error class so tests can construct rejections with it.
const MockTemplateFetchError = fetcher.TemplateFetchError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function latestCall(): FetchCall {
  if (fetchCalls.length === 0) {
    throw new Error("fetchAndExtract has not been called yet");
  }
  return fetchCalls[fetchCalls.length - 1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TemplateFetch screen (07-template.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchCalls.length = 0;
  });

  // ── 1. Initial render shows loading/progress state ────────────────────────

  it("shows a progress/loading state on initial render", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(
        text.match(/download|fetch|progress|starting|loading|resolving/i) !== null ||
        document.querySelector("[role='progressbar']") !== null
      ).toBe(true);
    });
  });

  it("calls fetchAndExtract on mount with the supplied targetDir", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });
    expect(latestCall().targetDir).toBe("/tmp/hq");
    // tag is undefined → fetcher picks the latest non-prerelease release.
    expect(latestCall().tag).toBeUndefined();
  });

  it("passes an AbortSignal to fetchAndExtract so unmount can cancel", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);
    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });
    expect(latestCall().signal).toBeInstanceOf(AbortSignal);
  });

  // ── 2. Progress callback updates the display ─────────────────────────────

  it("updates the progress display when onProgress is invoked", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });

    act(() => {
      latestCall().onProgress?.({ bytes: 512 * 1024, total: 2 * 1024 * 1024 });
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.match(/\d+(\.\d+)?\s*(kb|mb|b)/i) !== null).toBe(true);
    });
  });

  // ── 3. On done, Continue button appears ───────────────────────────────────

  it("shows a Continue button when fetchAndExtract resolves", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" onNext={vi.fn()} />);

    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });

    await act(async () => {
      latestCall().resolve({ version: "v1.2.3" });
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
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });

    await act(async () => {
      latestCall().resolve({ version: "v1.2.3" });
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

  // ── 4. On error, Retry + View log buttons appear ─────────────────────────

  it("shows a Retry button when fetchAndExtract rejects", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });

    await act(async () => {
      latestCall().reject(new MockTemplateFetchError("Network error", true));
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
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });

    await act(async () => {
      latestCall().reject(new MockTemplateFetchError("Network error", true));
    });

    await waitFor(() => {
      const btn =
        screen.queryByRole("button", { name: /view log/i }) ||
        screen.queryByRole("button", { name: /log/i });
      expect(btn).not.toBeNull();
    });
  });

  // ── 5. Retry re-invokes fetchAndExtract ──────────────────────────────────

  it("clicking Retry re-invokes fetchAndExtract", async () => {
    const user = userEvent.setup();
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      latestCall().reject(new MockTemplateFetchError("Network error", true));
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
      expect(mockFetchAndExtract.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── 6. No purple/indigo class names ──────────────────────────────────────

  it("does NOT use 'purple' class names in the DOM", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);
    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });
    expect(document.body.innerHTML).not.toMatch(/\bpurple\b/);
  });

  it("does NOT use 'indigo' class names in the DOM", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);
    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });
    expect(document.body.innerHTML).not.toMatch(/\bindigo\b/);
  });

  // ── 7. Does NOT call the legacy Rust fetch_template command ──────────────

  it("never invokes the legacy Rust fetch_template command", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    render(<TemplateFetch targetDir="/tmp/hq" />);
    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });
    const fetchTemplateCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "fetch_template"
    );
    expect(fetchTemplateCalls).toHaveLength(0);
  });

  // ── 8. Renders cleanly ────────────────────────────────────────────────────

  it("renders cleanly when the fetcher is mocked", () => {
    expect(() => {
      render(<TemplateFetch targetDir="/tmp/hq" />);
    }).not.toThrow();
  });
});
