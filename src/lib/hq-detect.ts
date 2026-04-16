// hq-detect.ts — US-015
// Simple passthrough — delegates HQ detection to the Tauri backend.

import { invoke } from "@tauri-apps/api/core";

export async function detectHq(path: string): Promise<{ exists: boolean; isHq: boolean }> {
  return invoke<{ exists: boolean; isHq: boolean }>("detect_hq", { path });
}
