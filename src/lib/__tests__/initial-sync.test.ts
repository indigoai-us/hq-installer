import { describe, it, expect, vi } from "vitest";
import {
  startInitialCloudSync,
  HQ_CLOUD_PACKAGE,
  type SpawnArgs,
} from "../initial-sync.js";

// ---------------------------------------------------------------------------
// startInitialCloudSync — provisions the personal bucket, then spawns the same
// hq-cloud-sync runner HQ-Sync uses. vend/provision + the Tauri spawn are
// injected so these tests never touch the network or a real subprocess.
// ---------------------------------------------------------------------------

const PERSON = { ownerSub: "sub-1", displayName: "Jane Doe" };

describe("startInitialCloudSync", () => {
  it("provisions the bucket, then spawns the runner with HQ-Sync's exact args", async () => {
    const ensure = vi.fn(async () => ({
      personUid: "prs_1",
      bucketName: "hq-vault-prs-1",
    }));
    const spawn = vi.fn(async (_args: SpawnArgs) => "handle-1");

    const res = await startInitialCloudSync("/home/u/hq", "tok", PERSON, {
      ensure,
      spawn,
    });

    expect(ensure).toHaveBeenCalledWith("tok", PERSON);

    expect(spawn).toHaveBeenCalledTimes(1);
    const arg = spawn.mock.calls[0][0];
    expect(arg.cmd).toBe("npx");
    expect(arg.args).toEqual([
      "-y",
      `--package=${HQ_CLOUD_PACKAGE}`,
      "hq-sync-runner",
      "--companies",
      "--direction",
      "both",
      "--on-conflict",
      "keep",
      "--hq-root",
      "/home/u/hq",
    ]);
    expect(arg.env).toEqual({ HQ_ROOT: "/home/u/hq" });
    expect(arg.cwd).toBe("/home/u/hq");

    expect(res).toEqual({ personUid: "prs_1", handle: "handle-1" });
  });

  it("pins the runner to the same @indigoai-us/hq-cloud version HQ-Sync uses", () => {
    expect(HQ_CLOUD_PACKAGE).toBe("@indigoai-us/hq-cloud@~5.38.0");
  });

  it("provisions BEFORE spawning (order matters — runner 422s on a missing bucket)", async () => {
    const order: string[] = [];
    const ensure = vi.fn(async () => {
      order.push("ensure");
      return { personUid: "p", bucketName: "b" };
    });
    const spawn = vi.fn(async () => {
      order.push("spawn");
      return "h";
    });

    await startInitialCloudSync("/home/u/hq", "tok", PERSON, { ensure, spawn });
    expect(order).toEqual(["ensure", "spawn"]);
  });

  it("never spawns the runner if provisioning fails", async () => {
    const ensure = vi.fn(async () => {
      throw new Error("422 ENTITY_NOT_PROVISIONED");
    });
    const spawn = vi.fn(async () => "h");

    await expect(
      startInitialCloudSync("/home/u/hq", "tok", PERSON, { ensure, spawn })
    ).rejects.toThrow(/ENTITY_NOT_PROVISIONED/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
