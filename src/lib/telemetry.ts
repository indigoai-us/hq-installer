// telemetry.ts — US-018
// Fire-and-forget telemetry pings.
// Pure module — does NOT import wizard-state. Callers check opt-in before calling.

import { fetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { CLIENT_HEADERS } from "./client-info";

const TELEMETRY_ENDPOINT = "https://telemetry.getindigo.ai/v1/installer/success";
const STEP_ENDPOINT = "https://telemetry.getindigo.ai/v1/installer/step";

// Anonymous install-session id, minted once per installer process. It is the
// spine of the step funnel before sign-in; once a personUid is known it rides
// each ping so the server stitches the session to the person.
let installSessionId: string | null = null;
export function getInstallSessionId(): string {
  if (!installSessionId) installSessionId = crypto.randomUUID();
  return installSessionId;
}

// Stable, privacy-preserving device id (a hashed MAC from the Rust side) used to
// spot the same machine installing again. Best-effort: only a SUCCESSFUL, non-
// empty id is memoized — a failure/empty returns undefined WITHOUT caching, so a
// transient miss is retried on the next ping (and never permanently disables the
// device dimension).
let deviceIdCache: string | undefined;
async function getDeviceId(): Promise<string | undefined> {
  if (deviceIdCache) return deviceIdCache;
  // Command unavailable / failed → "" → the funnel records without a device id
  // and retries on the next ping (no negative caching).
  const id = await invoke<string>("device_fingerprint").catch(() => "");
  if (typeof id === "string" && id) {
    deviceIdCache = id;
    return id;
  }
  return undefined;
}

/** Test-only: clear the memoized session id + device id between cases. */
export function __resetTelemetryCachesForTests(): void {
  installSessionId = null;
  deviceIdCache = undefined;
}

/**
 * Fire-and-forget ping for one installer step (welcome → install → signin →
 * setup → done). Anonymous by `installSessionId`; attaches `personUid` once the
 * user has signed in and a best-effort hashed device id. Errors are swallowed —
 * a telemetry failure must never block the wizard. Caller gates on the user's
 * telemetry opt-in.
 */
export async function pingStep(opts: {
  step: string;
  personUid?: string;
  version?: string;
}): Promise<void> {
  try {
    const deviceId = await getDeviceId();
    await fetch(STEP_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CLIENT_HEADERS },
      body: JSON.stringify({
        installSessionId: getInstallSessionId(),
        step: opts.step,
        ...(opts.personUid ? { personUid: opts.personUid } : {}),
        ...(deviceId ? { deviceId } : {}),
        version: opts.version ?? "unknown",
        ts: Date.now(),
      }),
    });
  } catch (err) {
    console.error("[telemetry] pingStep failed:", err);
  }
}

/**
 * Failure-notification endpoint. The server forwards POSTs here to the
 * #installer-alerts Slack channel. Override via VITE_INSTALLER_FAILURE_URL
 * for staging or a self-hosted alternative; setting it to an empty string
 * disables failure pings entirely (useful for local dev).
 */
const FAILURE_ENDPOINT_DEFAULT =
  "https://telemetry.getindigo.ai/v1/installer/failure";

function getFailureEndpoint(): string | null {
  const v = import.meta.env.VITE_INSTALLER_FAILURE_URL as string | undefined;
  // An explicit empty string disables; undefined falls back to the default.
  if (v === "") return null;
  return v ?? FAILURE_ENDPOINT_DEFAULT;
}

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
    headers: { "Content-Type": "application/json", ...CLIENT_HEADERS },
    body: JSON.stringify({ version: version ?? "unknown", ts: Date.now() }),
  });
}

export interface FailurePayload {
  /** Short identifier for where the failure happened. e.g. "template-fetch",
   *  "pack-install:hq-pack-design-quality", "deps:node", "cognito-auth". */
  stage: string;
  /** Human-readable error message. */
  message: string;
  /** Optional installer version. */
  version?: string;
  /** Optional small structured payload (truncated server-side if oversized). */
  detail?: Record<string, unknown>;
}

/**
 * Fire-and-forget ping to the failure endpoint. The server forwards the
 * payload to a Slack channel so on-call engineers see install regressions
 * immediately. Errors are logged to console only — never throw.
 *
 * Caller responsibility: gate on `wizardState.telemetryEnabled` if the
 * failure happens before opt-in is meaningful.
 */
export async function pingFailure(payload: FailurePayload): Promise<void> {
  const endpoint = getFailureEndpoint();
  if (!endpoint) return;
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CLIENT_HEADERS },
      body: JSON.stringify({
        ...payload,
        version: payload.version ?? "unknown",
        ts: Date.now(),
      }),
    });
  } catch (err) {
    console.error("[telemetry] pingFailure failed:", err);
  }
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
    ...CLIENT_HEADERS,
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
