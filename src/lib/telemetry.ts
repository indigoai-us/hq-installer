// telemetry.ts — US-018
// Fire-and-forget telemetry pings.
// Pure module — does NOT import wizard-state. Callers check opt-in before calling.

import { fetch } from "@tauri-apps/plugin-http";

const TELEMETRY_ENDPOINT = "https://telemetry.getindigo.ai/v1/installer/success";

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
