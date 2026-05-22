import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// TemplateFetch screen tests (07-template.tsx)
//
// Phase 1 (template fetch) goes through `@/lib/template-fetcher`; Phase 2
// (pack install) enumerates the catalog through `@/lib/pack-registry` and
// installs the packs the user checks. Both libs are mocked so tests drive
// resolution from the test body without network or filesystem.
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

// `vi.mock` factories are hoisted, so the factory can't reference outer
// identifiers — it reaches `fetchCalls` lazily through `globalThis`.
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

// Pack catalog — five packs; the first four are "recommended" so they start
// checked, `hq-pack-engineering` starts unchecked.
vi.mock("@/lib/pack-registry", () => {
  const CATALOG = [
    {
      dir: "hq-pack-design-quality",
      name: "hq-pack-design-quality",
      description: "Design quality references.",
      source:
        "github:indigoai-us/hq-packages#packages/hq-pack-design-quality",
    },
    {
      dir: "hq-pack-design-styles",
      name: "hq-pack-design-styles",
      description: "Curated style packs.",
      source: "github:indigoai-us/hq-packages#packages/hq-pack-design-styles",
    },
    {
      dir: "hq-pack-gemini",
      name: "hq-pack-gemini",
      description: "Gemini CLI workers.",
      source: "github:indigoai-us/hq-packages#packages/hq-pack-gemini",
    },
    {
      dir: "hq-pack-gstack",
      name: "hq-pack-gstack",
      description: "gstack team workers.",
      source: "github:indigoai-us/hq-packages#packages/hq-pack-gstack",
    },
    {
      dir: "hq-pack-engineering",
      name: "hq-pack-engineering",
      description: "Engineering capabilities.",
      source: "github:indigoai-us/hq-packages#packages/hq-pack-engineering",
    },
  ];
  return {
    FALLBACK_PACKS: CATALOG.slice(0, 4),
    fetchAvailablePacks: vi.fn(async () => CATALOG),
    readRecommendedPackIds: vi.fn(
      async () =>
        new Set([
          "hq-pack-design-quality",
          "hq-pack-design-styles",
          "hq-pack-gemini",
          "hq-pack-gstack",
        ]),
    ),
  };
});

// Mock the Tauri core `invoke`. For `spawn_process` (pack install) return a
// unique handle per call so `listen` subscriptions don't collide.
vi.mock("@tauri-apps/api/core", () => {
  let handleCounter = 0;
  return {
    invoke: vi.fn(async (cmd: string) => {
      if (cmd === "spawn_process") return `h${++handleCounter}`;
      return undefined;
    }),
  };
});

// Mock the Tauri event bus. Pack-install listens on three events per spawned
// process; we only need `/exit` to fire with success so the loop proceeds.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    if (typeof event === "string" && event.endsWith("/exit")) {
      queueMicrotask(() => cb({ payload: { code: 0, success: true } }));
    }
    return () => {};
  }),
}));

// Disk-log writes go through plugin-fs; no-op in tests.
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  writeTextFile: vi.fn(async () => {}),
}));

// Bridge: expose fetchCalls via globalThis so the hoisted factory can reach it.
(globalThis as { __fetchCalls?: FetchCall[] }).__fetchCalls = fetchCalls;

// Import AFTER vi.mock so the component picks up the mocked helpers.
import { TemplateFetch } from "../07-template.js";
import * as fetcher from "@/lib/template-fetcher";
import * as packRegistry from "@/lib/pack-registry";
const mockFetchAndExtract = vi.mocked(fetcher.fetchAndExtract);
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

/** Sources passed to every `npx hq install` spawn so far. Accepts a mock's
 *  `.mock.calls` array. */
function installedSources(calls: readonly unknown[][]): string[] {
  return calls
    .filter((c) => c[0] === "spawn_process")
    .map((c) => {
      const args = (c[1] as { args: { args: string[] } }).args.args;
      return args[args.length - 1];
    });
}

/** Resolve the template fetch and wait for the pack checklist to render. */
async function resolveTemplateAndAwaitChecklist(): Promise<void> {
  await waitFor(() => {
    expect(mockFetchAndExtract).toHaveBeenCalled();
  });
  await act(async () => {
    latestCall().resolve({ version: "v1.2.3" });
  });
  await waitFor(() => {
    expect(screen.queryAllByRole("checkbox").length).toBeGreaterThan(0);
  });
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
          document.querySelector("[role='progressbar']") !== null,
      ).toBe(true);
    });
  });

  it("calls fetchAndExtract on mount with the supplied targetDir", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });
    expect(latestCall().targetDir).toBe("/tmp/hq");
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

  // ── 3. On done, the pack-choice step + Continue appear ───────────────────

  it("shows a Continue button when fetchAndExtract resolves", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" onNext={vi.fn()} />);

    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });
    await act(async () => {
      latestCall().resolve({ version: "v1.2.3" });
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /continue/i }),
      ).not.toBeNull();
    });
  });

  // ── 4. Pack catalog — one checkbox per pack, recommended pre-checked ─────

  it("renders a checkbox for every available pack, recommended ones pre-checked", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" onNext={vi.fn()} />);
    await resolveTemplateAndAwaitChecklist();

    // All five catalog packs are listed.
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);

    const cb = (id: string) =>
      screen.getByRole("checkbox", { name: id }) as HTMLInputElement;
    // The four recommended packs start checked…
    expect(cb("hq-pack-design-quality").checked).toBe(true);
    expect(cb("hq-pack-design-styles").checked).toBe(true);
    expect(cb("hq-pack-gemini").checked).toBe(true);
    expect(cb("hq-pack-gstack").checked).toBe(true);
    // …and the non-recommended one starts unchecked.
    expect(cb("hq-pack-engineering").checked).toBe(false);
  });

  // ── 5. Install only the checked packs ────────────────────────────────────

  it("installs only the checked packs when Continue is clicked", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const user = userEvent.setup();
    render(<TemplateFetch targetDir="/tmp/hq" onNext={vi.fn()} />);
    await resolveTemplateAndAwaitChecklist();

    // Default selection = the four recommended packs.
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(installedSources(mockInvoke.mock.calls)).toHaveLength(4);
    });
    const sources = installedSources(mockInvoke.mock.calls);
    expect(sources).toEqual([
      "github:indigoai-us/hq-packages#packages/hq-pack-design-quality",
      "github:indigoai-us/hq-packages#packages/hq-pack-design-styles",
      "github:indigoai-us/hq-packages#packages/hq-pack-gemini",
      "github:indigoai-us/hq-packages#packages/hq-pack-gstack",
    ]);
    // The unchecked pack was not installed.
    expect(sources).not.toContain(
      "github:indigoai-us/hq-packages#packages/hq-pack-engineering",
    );
  });

  it("installs an extra pack once the user checks it", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const user = userEvent.setup();
    render(<TemplateFetch targetDir="/tmp/hq" onNext={vi.fn()} />);
    await resolveTemplateAndAwaitChecklist();

    // Opt the non-recommended pack in.
    await user.click(
      screen.getByRole("checkbox", { name: "hq-pack-engineering" }),
    );
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(installedSources(mockInvoke.mock.calls)).toHaveLength(5);
    });
    expect(installedSources(mockInvoke.mock.calls)).toContain(
      "github:indigoai-us/hq-packages#packages/hq-pack-engineering",
    );
  });

  it("uses npx + the pinned hq-cli for each pack install", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const user = userEvent.setup();
    render(<TemplateFetch targetDir="/tmp/hq" onNext={vi.fn()} />);
    await resolveTemplateAndAwaitChecklist();

    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(installedSources(mockInvoke.mock.calls)).toHaveLength(4);
    });
    const spawnCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "spawn_process",
    );
    for (const [, payload] of spawnCalls) {
      const args = (payload as { args: { cmd: string; args: string[]; cwd: string } })
        .args;
      expect(args.cmd).toBe("npx");
      expect(args.args).toContain("install");
      expect(args.args.some((a) => a.includes("@indigoai-us/hq-cli"))).toBe(true);
      expect(args.cwd).toBe("/tmp/hq");
    }
  });

  // ── 6. Skip path — nothing checked ───────────────────────────────────────

  it("skips the install and advances when every pack is unchecked", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<TemplateFetch targetDir="/tmp/hq" onNext={onNext} />);
    await resolveTemplateAndAwaitChecklist();

    // Uncheck every currently-checked pack.
    for (const cb of screen.getAllByRole("checkbox")) {
      if ((cb as HTMLInputElement).checked) await user.click(cb);
    }
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(installedSources(mockInvoke.mock.calls)).toHaveLength(0);
  });

  // ── 7. Continue advances after the install completes ─────────────────────

  it("advances via Continue after the selected packs install", async () => {
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<TemplateFetch targetDir="/tmp/hq" onNext={onNext} />);
    await resolveTemplateAndAwaitChecklist();

    // Start the install (four recommended packs by default).
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // Once the mocked packs all exit, the final Continue advances the wizard.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /continue/i }),
      ).not.toBeNull();
    });
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  // ── 8. Catalog fetch failure → fall back to the core packs ───────────────

  it("falls back to the core packs when the catalog can't be fetched", async () => {
    vi.mocked(packRegistry.fetchAvailablePacks).mockRejectedValueOnce(
      new Error("rate limited"),
    );
    render(<TemplateFetch targetDir="/tmp/hq" onNext={vi.fn()} />);
    await resolveTemplateAndAwaitChecklist();

    // FALLBACK_PACKS has four entries.
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    expect(document.body.textContent ?? "").toMatch(/couldn't load/i);
  });

  // ── 9. On error, Retry + View log buttons appear ─────────────────────────

  it("shows a Retry button when fetchAndExtract rejects", async () => {
    render(<TemplateFetch targetDir="/tmp/hq" />);

    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });
    await act(async () => {
      latestCall().reject(new MockTemplateFetchError("Network error", true));
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /retry/i }) ||
          screen.queryByRole("button", { name: /try again/i }),
      ).not.toBeNull();
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
      expect(
        screen.queryByRole("button", { name: /view log/i }) ||
          screen.queryByRole("button", { name: /log/i }),
      ).not.toBeNull();
    });
  });

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
          screen.queryByRole("button", { name: /try again/i }),
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

  // ── 10. No purple/indigo class names ─────────────────────────────────────

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

  // ── 11. Does NOT call the legacy Rust fetch_template command ─────────────

  it("never invokes the legacy Rust fetch_template command", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    render(<TemplateFetch targetDir="/tmp/hq" />);
    await waitFor(() => {
      expect(mockFetchAndExtract).toHaveBeenCalled();
    });
    const fetchTemplateCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "fetch_template",
    );
    expect(fetchTemplateCalls).toHaveLength(0);
  });

  // ── 12. Renders cleanly ───────────────────────────────────────────────────

  it("renders cleanly when the helpers are mocked", () => {
    expect(() => {
      render(<TemplateFetch targetDir="/tmp/hq" />);
    }).not.toThrow();
  });
});
