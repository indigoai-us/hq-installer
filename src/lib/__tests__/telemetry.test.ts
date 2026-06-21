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
import {
  postOptIn,
  pingStep,
  getInstallSessionId,
  __resetTelemetryCachesForTests,
} from "../telemetry.js";

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

// ---------------------------------------------------------------------------
// pingStep — installer step funnel
// ---------------------------------------------------------------------------

describe("pingStep", () => {
  beforeEach(() => {
    // The session id + device id are memoized at module scope; clear them so
    // a success cached by one case doesn't leak into the next.
    __resetTelemetryCachesForTests();
  });

  it("POSTs the step with a stable session id, personUid, and best-effort device id", async () => {
    vi.useRealTimers();
    // device_fingerprint resolves to a hash for this test.
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue("hashed-mac-abc");
    globalThis.fetch = sequencedFetch([makeResponse(200, { ok: true })]);

    await pingStep({ step: "signin", personUid: "prs_ada", version: "9.9.9" });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/installer\/step$/);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      step: "signin",
      personUid: "prs_ada",
      deviceId: "hashed-mac-abc",
      version: "9.9.9",
      installSessionId: getInstallSessionId(),
    });
    // The session id is stable across pings within a process.
    expect(typeof body.installSessionId).toBe("string");
    expect(body.installSessionId.length).toBeGreaterThan(0);
  });

  it("omits deviceId + personUid gracefully when unavailable", async () => {
    vi.useRealTimers();
    (invoke as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no command"));
    globalThis.fetch = sequencedFetch([makeResponse(200, { ok: true })]);

    await pingStep({ step: "welcome", version: "9.9.9" });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect("deviceId" in body).toBe(false);
    expect("personUid" in body).toBe(false);
    expect(body.step).toBe("welcome");
  });

  it("never throws when the network fails", async () => {
    vi.useRealTimers();
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue("");
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(pingStep({ step: "done" })).resolves.toBeUndefined();
  });
});
