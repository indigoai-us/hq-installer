// telemetry.ts — US-018
// Fire-and-forget telemetry pings.
// Pure module — does NOT import wizard-state. Callers check opt-in before calling.

import { fetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";

const TELEMETRY_ENDPOINT = "https://telemetry.getindigo.ai/v1/installer/success";

// hq-prod custom domain (canonical post-2026-04-28 cutover). Override via VITE_VAULT_API_URL.
const DEFAULT_VAULT_API_URL = "https://hqapi.getindigo.ai";

function getVaultApiUrl(): string {
  return (
    (import.meta.env.VITE_VAULT_API_URL as string | undefined) ??
    DEFAULT_VAULT_API_URL
  );
}

/**
 * Ping the telemetry endpoint with a success event.
 * Errors are silently swallowed — callers should use `.catch(() => {})`.
 *
 * @param version - Optional installer version string (defaults to "unknown").
 */
export async function pingSuccess(version?: string): Promise<void> {
  await fetch(TELEMETRY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: version ?? "unknown", ts: Date.now() }),
  });
}

/**
 * POST the user's telemetry opt-in preference to the vault-service and write
 * it to the local ~/.hq/menubar.json cache via the `write_menubar_telemetry_pref`
 * Tauri command.
 *
 * Retry semantics: attempt 1 → wait 1 s → attempt 2 → wait 3 s → attempt 3.
 * On final failure: log to stderr and still write the local cache so the
 * installer advances and hq-sync can fall back to the local value.
 */
export async function postOptIn({
  accessToken,
  enabled,
}: {
  accessToken: string;
  enabled: boolean;
}): Promise<void> {
  const url = `${getVaultApiUrl()}/v1/usage/opt-in`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  const body = JSON.stringify({ enabled });

  const delays = [1000, 3000]; // ms between attempts
  let lastError: unknown;
  let succeeded = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers, body });
      if (res.ok) {
        succeeded = true;
        break;
      }
      lastError = new Error(`POST /v1/usage/opt-in returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < delays.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }

  if (!succeeded) {
    console.error("[telemetry] postOptIn failed after 3 attempts:", lastError);
  }

  // Always write local cache — even on network failure — so hq-sync can fall back.
  try {
    await invoke("write_menubar_telemetry_pref", { enabled });
  } catch (err) {
    console.error("[telemetry] write_menubar_telemetry_pref failed:", err);
  }
}
