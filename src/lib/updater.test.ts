import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// updater integration tests (US-025)
//
// These tests are written BEFORE the implementation exists.
// They will fail until src/lib/updater.ts is created.
//
// Strategy: mock @tauri-apps/plugin-updater so the module can be exercised
// in Vitest (jsdom) without a live Tauri runtime.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mock @tauri-apps/plugin-updater BEFORE importing the module under test
// ---------------------------------------------------------------------------

/** The check() mock — configured per-test via mockCheck */
const mockCheck = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => mockCheck(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are registered
// ---------------------------------------------------------------------------

import { checkForUpdate, installUpdate } from "./updater.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Tauri update manifest shape returned by check() */
interface MockUpdate {
  available: boolean;
  currentVersion: string;
  version?: string;
  body?: string;
  downloadAndInstall?: () => Promise<void>;
}

/** Build a mock Update object that tauri-plugin-updater's check() resolves to */
function makeUpdate(overrides: Partial<MockUpdate> = {}): MockUpdate {
  return {
    available: false,
    currentVersion: "1.0.0",
    version: undefined,
    body: undefined,
    downloadAndInstall: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockCheck.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkForUpdate()", () => {
  // -------------------------------------------------------------------------
  it("returns { available: false } when the running version matches the manifest", async () => {
    // Tauri's check() returns an object with available=false when up-to-date
    mockCheck.mockResolvedValueOnce(
      makeUpdate({ available: false, currentVersion: "1.2.3" }),
    );

    const result = await checkForUpdate();

    expect(result.available).toBe(false);
    // version and body should be absent/undefined when no update is available
    expect(result.version).toBeUndefined();
    expect(result.body).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  it("returns { available: true, version, body } when manifest has a newer version", async () => {
    const releaseNotes = "Fixed critical bug in onboarding flow";

    mockCheck.mockResolvedValueOnce(
      makeUpdate({
        available: true,
        currentVersion: "1.0.0",
        version: "1.1.0",
        body: releaseNotes,
      }),
    );

    const result = await checkForUpdate();

    expect(result.available).toBe(true);
    expect(result.version).toBe("1.1.0");
    expect(result.body).toBe(releaseNotes);
  });

  // -------------------------------------------------------------------------
  it("returns { available: true } with version and body when body is absent from manifest", async () => {
    // Some manifests omit body — updater should handle gracefully
    mockCheck.mockResolvedValueOnce(
      makeUpdate({
        available: true,
        currentVersion: "1.0.0",
        version: "1.2.0",
        body: undefined,
      }),
    );

    const result = await checkForUpdate();

    expect(result.available).toBe(true);
    expect(result.version).toBe("1.2.0");
    // body is optional — may be undefined or empty string; either is acceptable
    expect(result.body == null || typeof result.body === "string").toBe(true);
  });

  // -------------------------------------------------------------------------
  it("rejects with an error when the manifest response is malformed (check() rejects)", async () => {
    // Simulate Tauri's check() throwing when the remote manifest is unparseable
    mockCheck.mockRejectedValueOnce(new Error("Failed to parse update manifest"));

    await expect(checkForUpdate()).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  it("rejects with an error when check() returns null/undefined (missing manifest)", async () => {
    // Simulate the plugin returning nothing (network error, S3 outage, etc.)
    mockCheck.mockResolvedValueOnce(null);

    await expect(checkForUpdate()).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  it("rejects with an error when the manifest is missing required 'version' field on an available update", async () => {
    // available=true but no version — manifest is malformed
    mockCheck.mockResolvedValueOnce(
      makeUpdate({
        available: true,
        currentVersion: "1.0.0",
        version: undefined, // version field missing
        body: "Some notes",
      }),
    );

    await expect(checkForUpdate()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("installUpdate()", () => {
  // -------------------------------------------------------------------------
  it("calls downloadAndInstall() on the update object returned by check()", async () => {
    const mockDownloadAndInstall = vi
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);

    mockCheck.mockResolvedValueOnce(
      makeUpdate({
        available: true,
        currentVersion: "1.0.0",
        version: "2.0.0",
        body: "Major release",
        downloadAndInstall: mockDownloadAndInstall,
      }),
    );

    await installUpdate();

    expect(mockDownloadAndInstall).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  it("rejects if no update is available when installUpdate() is called", async () => {
    // Calling installUpdate when there is nothing to install should fail loudly
    mockCheck.mockResolvedValueOnce(
      makeUpdate({ available: false, currentVersion: "1.0.0" }),
    );

    await expect(installUpdate()).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  it("propagates errors thrown by downloadAndInstall()", async () => {
    const mockDownloadAndInstall = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("Install failed: disk full"));

    mockCheck.mockResolvedValueOnce(
      makeUpdate({
        available: true,
        currentVersion: "1.0.0",
        version: "2.0.0",
        downloadAndInstall: mockDownloadAndInstall,
      }),
    );

    await expect(installUpdate()).rejects.toThrow("Install failed: disk full");
  });
});
