import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Route @tauri-apps/plugin-http fetch through globalThis.fetch so we can
// intercept it in tests.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init),
}));

// Mock the Tauri invoke used by write_menubar_telemetry_pref.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));

import { invoke } from "@tauri-apps/api/core";
import { postOptIn } from "../telemetry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// Fake fetch that returns the given sequence of responses in order.
function sequencedFetch(responses: Response[]) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i++];
    if (!r) throw new Error("No more mock responses");
    return r;
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const FAKE_ACCESS_TOKEN = "test-access-token";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("postOptIn — happy path", () => {
  it("POSTs {enabled:true} to /v1/usage/opt-in and writes local cache on success", async () => {
    globalThis.fetch = sequencedFetch([makeResponse(200, { ok: true })]);

    const promise = postOptIn({ accessToken: FAKE_ACCESS_TOKEN, enabled: true });
    // Advance any timers (there should be none on success path)
    await vi.runAllTimersAsync();
    await promise;

    // Exactly one HTTP call was made
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/usage\/opt-in$/);
    expect(init.method).toBe("POST");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ enabled: true });
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${FAKE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    });

    // Local cache written via Tauri command
    expect(invoke).toHaveBeenCalledWith("write_menubar_telemetry_pref", { enabled: true });
  });

  it("POSTs {enabled:false} when telemetry is off", async () => {
    globalThis.fetch = sequencedFetch([makeResponse(200, { ok: true })]);

    const promise = postOptIn({ accessToken: FAKE_ACCESS_TOKEN, enabled: false });
    await vi.runAllTimersAsync();
    await promise;

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
    expect(invoke).toHaveBeenCalledWith("write_menubar_telemetry_pref", { enabled: false });
  });
});

// ---------------------------------------------------------------------------
// Retry on 500
// ---------------------------------------------------------------------------

describe("postOptIn — retry on server error", () => {
  it("retries twice on 500 then succeeds on third attempt", async () => {
    globalThis.fetch = sequencedFetch([
      makeResponse(500, { error: "server error" }),
      makeResponse(500, { error: "server error" }),
      makeResponse(200, { ok: true }),
    ]);

    const promise = postOptIn({ accessToken: FAKE_ACCESS_TOKEN, enabled: true });
    // Advance through the two backoff delays (1 s + 3 s)
    await vi.advanceTimersByTimeAsync(1000); // after first failure
    await vi.advanceTimersByTimeAsync(3000); // after second failure
    await promise;

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    // Cache written after eventual success
    expect(invoke).toHaveBeenCalledWith("write_menubar_telemetry_pref", { enabled: true });
  });
});

// ---------------------------------------------------------------------------
// Local-cache fallback on final failure
// ---------------------------------------------------------------------------

describe("postOptIn — local cache on final failure", () => {
  it("writes local cache and logs to stderr even when all retries fail", async () => {
    globalThis.fetch = sequencedFetch([
      makeResponse(500, {}),
      makeResponse(500, {}),
      makeResponse(500, {}),
    ]);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const promise = postOptIn({ accessToken: FAKE_ACCESS_TOKEN, enabled: true });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    // All three attempts exhausted
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    // Local cache still written (fail-open)
    expect(invoke).toHaveBeenCalledWith("write_menubar_telemetry_pref", { enabled: true });
    // Logged to stderr
    expect(stderrSpy).toHaveBeenCalled();
    // The function must NOT throw — installer must advance
  });

  it("writes local cache when network throws on every attempt", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      throw new Error("network error");
    });

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const promise = postOptIn({ accessToken: FAKE_ACCESS_TOKEN, enabled: false });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(calls).toBe(3);
    expect(invoke).toHaveBeenCalledWith("write_menubar_telemetry_pref", { enabled: false });
    expect(stderrSpy).toHaveBeenCalled();
  });
});
