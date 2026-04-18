import { check } from "@tauri-apps/plugin-updater";

export interface UpdateInfo {
  available: boolean;
  version?: string;
  body?: string;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const update = await check();
  if (update === null || update === undefined) {
    throw new Error("Failed to check for updates: no response");
  }
  if (!update.available) {
    return { available: false };
  }
  if (!update.version) {
    throw new Error("Malformed update manifest: version missing");
  }
  return {
    available: true,
    version: update.version,
    body: update.body,
  };
}

export async function installUpdate(): Promise<void> {
  const update = await check();
  if (!update?.available) {
    throw new Error("No update available to install");
  }
  await update.downloadAndInstall();
}
