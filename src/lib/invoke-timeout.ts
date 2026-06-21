import { invoke } from "@tauri-apps/api/core";

export class TimeoutError extends Error {
  constructor(
    public readonly command: string,
    public readonly ms: number,
  ) {
    super(`Timed out after ${ms}ms waiting for ${command}`);
    this.name = "TimeoutError";
  }
}

export async function invokeWithTimeout<T>(
  command: string,
  args?: Record<string, unknown>,
  ms = 10_000,
): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new TimeoutError(command, ms));
    }, ms);
  });

  try {
    return await Promise.race([invoke<T>(command, args), timeout]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}
