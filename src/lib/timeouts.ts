export const DOWNLOAD_SLOW_NOTICE_MS = 20_000;
export const DOWNLOAD_STALL_MS = 12_000;
export const DOWNLOAD_HARD_STALL_MS = 25_000;
export const SETUP_STAGE_SKIP_MS = 90_000;
// Dependency install and HQ Sync download legitimately take much longer
// (toolchain downloads, npm installs, DMG fetch), so the Skip affordance waits
// longer before appearing on those stages.
export const SETUP_STAGE_SKIP_LONG_MS = 240_000;

export const INSTALL_PROBE_TIMEOUT_MS = 10_000;
export const SETUP_IPC_TIMEOUT_MS = 15_000;
