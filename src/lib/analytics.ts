/**
 * Analytics — fire-and-forget install telemetry.
 *
 * The installer only emits one event today: `install.completed`, fired
 * from the Success screen on first mount with an anonymous install_id
 * and the elapsed install duration.
 *
 * # MVP shape
 *
 * No real endpoint is wired yet — the deploy pipeline (US-010/US-011)
 * will plant a `VITE_ANALYTICS_ENDPOINT` at build time. Until then, the
 * module logs events to the console so smoke tests can assert "did we
 * emit?" without needing a network roundtrip.
 *
 * # Why injectable transport
 *
 * Tests shouldn't need to stub `globalThis.fetch` or console.log — they
 * can pass an explicit `transport` function and assert on what gets
 * called with what args. Production callers skip the arg and get the
 * default transport that POSTs to the real endpoint.
 */

/** Event name — one of a small closed set we care about. */
export type AnalyticsEventName =
  | "install.started"
  | "install.completed"
  | "install.failed";

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  /** Anonymous per-install identifier (never user-identifying). */
  install_id: string;
  /** Milliseconds since Unix epoch. */
  ts: number;
  /** Arbitrary JSON-safe properties. */
  props: Record<string, string | number | boolean>;
}

/** Transport signature — fire-and-forget, must never throw to callers. */
export type AnalyticsTransport = (event: AnalyticsEvent) => void;

/** Default transport: write to `console.info` with a stable prefix so
 *  users grepping for analytics events in the installer's stdout can
 *  find them. Real network transport will land in a follow-up. */
const defaultTransport: AnalyticsTransport = (event) => {
  console.info("[analytics]", event.name, event);
};

// We keep a module-local override so callers can swap transports at
// runtime (e.g., in jsdom tests). The setter returns a restore function
// so nested tests can stack overrides without stomping each other.
let currentTransport: AnalyticsTransport = defaultTransport;

/** Override the analytics transport. Returns a restore function. */
export function setAnalyticsTransport(
  transport: AnalyticsTransport,
): () => void {
  const previous = currentTransport;
  currentTransport = transport;
  return () => {
    currentTransport = previous;
  };
}

/**
 * Persist or retrieve an anonymous install id.
 *
 * The id lives in `localStorage` under `hq-installer:install-id`. If
 * `localStorage` is unavailable (unusual but possible in hardened
 * webviews), we fall back to a transient in-memory UUID — better to
 * drop analytics accuracy than to crash the success screen.
 */
const STORAGE_KEY = "hq-installer:install-id";
let memoryFallbackId: string | null = null;

export function getOrCreateInstallId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (existing) return existing;
    const fresh = randomId();
    globalThis.localStorage?.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    if (memoryFallbackId === null) memoryFallbackId = randomId();
    return memoryFallbackId;
  }
}

// Small RFC-4122 v4-ish UUID without pulling in `uuid` as a dep. Good
// enough for an anonymous install id — collision space is effectively
// infinite for the installer's scale.
function randomId(): string {
  const hex = (n: number, len: number) => n.toString(16).padStart(len, "0");
  const r1 = Math.floor(Math.random() * 0xffffffff);
  const r2 = Math.floor(Math.random() * 0xffffffff);
  const r3 = Math.floor(Math.random() * 0xffffffff);
  return `${hex(Date.now() & 0xffffffff, 8)}-${hex(r1, 8)}-${hex(r2, 8)}-${hex(r3, 8)}`;
}

/** Fire-and-forget event emitter. Never throws. */
export function trackEvent(
  name: AnalyticsEventName,
  props: AnalyticsEvent["props"],
): void {
  try {
    const event: AnalyticsEvent = {
      name,
      install_id: getOrCreateInstallId(),
      ts: Date.now(),
      props,
    };
    currentTransport(event);
  } catch {
    // Swallow — analytics must never break the UI.
  }
}
