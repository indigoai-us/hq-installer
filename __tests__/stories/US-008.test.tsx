import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { existsSync } from "fs";
import { join } from "path";
import { invoke } from "@tauri-apps/api/core";
import LocationRoute from "@/routes/Location";
import CloudSyncPanel, {
  type CloudDecision,
} from "@/routes/Location/CloudSyncPanel";
import OverwriteConfirm from "@/routes/Location/OverwriteConfirm";
import {
  signInManual,
  validateRepoSpec,
} from "@/lib/oauth-github";

const repoRoot = process.cwd();

/**
 * US-008: Install wizard — HQ location picker + cloud sync decision.
 *
 * Split across:
 *   1. File scaffold presence check
 *   2. oauth-github module unit tests (pure validation + signInManual)
 *   3. OverwriteConfirm modal render tests
 *   4. CloudSyncPanel state machine tests (hidden → signed-in → exists/not-found/error)
 *   5. LocationRoute end-to-end: fresh scaffold, TargetNotEmpty → overwrite,
 *      clone existing, skip cloud link
 */
describe("US-008: Location picker + cloud sync decision", () => {
  describe("File scaffold", () => {
    it("location route files all exist", () => {
      const paths = [
        "src/routes/Location/index.tsx",
        "src/routes/Location/CloudSyncPanel.tsx",
        "src/routes/Location/OverwriteConfirm.tsx",
        "src/lib/oauth-github.ts",
      ];
      for (const p of paths) {
        expect(existsSync(join(repoRoot, p))).toBe(true);
      }
    });
  });

  describe("oauth-github validation", () => {
    it("rejects empty strings with a required message", () => {
      expect(validateRepoSpec("")).toMatch(/required/i);
    });

    it("rejects strings without a slash", () => {
      expect(validateRepoSpec("indigoai-us")).toMatch(/owner\/repo/);
    });

    it("rejects strings with invalid characters", () => {
      expect(validateRepoSpec("indigo ai/hq")).toMatch(/invalid/i);
    });

    it("accepts a valid owner/repo spec", () => {
      expect(validateRepoSpec("indigoai-us/hq")).toBeNull();
    });

    it("signInManual returns ok + spec on valid input", async () => {
      const result = await signInManual("indigoai-us/hq");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.full_name).toBe("indigoai-us/hq");
        expect(result.spec.token).toBeNull();
      }
    });

    it("signInManual returns err on invalid input", async () => {
      const result = await signInManual("no-slash-here");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/owner\/repo/);
      }
    });
  });

  describe("OverwriteConfirm modal", () => {
    it("renders nothing when closed", () => {
      const { container } = render(
        <OverwriteConfirm
          open={false}
          targetPath="~/hq"
          onCancel={() => {}}
          onConfirm={() => {}}
        />,
      );
      expect(container.innerHTML).toBe("");
    });

    it("renders title, path and actions when open", () => {
      render(
        <OverwriteConfirm
          open
          targetPath="/Users/me/hq"
          onCancel={() => {}}
          onConfirm={() => {}}
        />,
      );
      expect(screen.getByTestId("overwrite-confirm")).toBeInTheDocument();
      expect(screen.getByTestId("overwrite-confirm-path")).toHaveTextContent(
        "/Users/me/hq",
      );
      expect(screen.getByTestId("overwrite-confirm-cancel")).toBeInTheDocument();
      expect(
        screen.getByTestId("overwrite-confirm-proceed"),
      ).toBeInTheDocument();
    });

    it("fires callbacks on button click", () => {
      const onCancel = vi.fn();
      const onConfirm = vi.fn();
      render(
        <OverwriteConfirm
          open
          targetPath="~/hq"
          onCancel={onCancel}
          onConfirm={onConfirm}
        />,
      );
      fireEvent.click(screen.getByTestId("overwrite-confirm-cancel"));
      fireEvent.click(screen.getByTestId("overwrite-confirm-proceed"));
      expect(onCancel).toHaveBeenCalled();
      expect(onConfirm).toHaveBeenCalled();
    });
  });

  describe("CloudSyncPanel state machine", () => {
    it("starts hidden and shows Sign-in button", () => {
      render(<CloudSyncPanel onDecision={() => {}} />);
      const panel = screen.getByTestId("cloud-sync-panel");
      expect(panel).toHaveAttribute("data-phase", "hidden");
      expect(screen.getByTestId("cloud-sync-signin")).toBeInTheDocument();
    });

    it("transitions to signed-in-input after clicking sign-in", async () => {
      render(<CloudSyncPanel onDecision={() => {}} />);
      fireEvent.click(screen.getByTestId("cloud-sync-signin"));
      await waitFor(() => {
        expect(screen.getByTestId("cloud-sync-panel")).toHaveAttribute(
          "data-phase",
          "signed-in-input",
        );
      });
      expect(screen.getByTestId("cloud-sync-repo-input")).toBeInTheDocument();
    });

    it("shows exists phase and emits clone decision when cloud backend returns exists=true", async () => {
      const invokeMock = vi.mocked(invoke);
      invokeMock.mockImplementationOnce(async () => ({
        result: "ok",
        info: {
          exists: true,
          last_modified: "2026-04-14T12:00:00Z",
          estimated_size: 123456,
        },
      }));

      const onDecision = vi.fn<(d: CloudDecision) => void>();
      render(<CloudSyncPanel onDecision={onDecision} />);
      fireEvent.click(screen.getByTestId("cloud-sync-signin"));
      await waitFor(() =>
        expect(screen.getByTestId("cloud-sync-repo-input")).toBeInTheDocument(),
      );
      fireEvent.change(screen.getByTestId("cloud-sync-repo-input"), {
        target: { value: "indigoai-us/hq" },
      });
      fireEvent.click(screen.getByTestId("cloud-sync-check"));

      await waitFor(() => {
        expect(screen.getByTestId("cloud-sync-panel")).toHaveAttribute(
          "data-phase",
          "exists",
        );
      });
      expect(screen.getByTestId("cloud-sync-found-repo")).toHaveTextContent(
        "indigoai-us/hq",
      );
      // The "clone" decision is emitted automatically when we land in exists.
      expect(onDecision).toHaveBeenLastCalledWith({
        action: "clone",
        spec: { backend: "github", repo: "indigoai-us/hq" },
      });
    });

    it("shows not-found phase + emits fresh decision when backend returns exists=false", async () => {
      const invokeMock = vi.mocked(invoke);
      // Default mock returns exists=false — explicit for clarity.
      invokeMock.mockImplementationOnce(async () => ({
        result: "ok",
        info: {
          exists: false,
          last_modified: null,
          estimated_size: null,
        },
      }));

      const onDecision = vi.fn<(d: CloudDecision) => void>();
      render(<CloudSyncPanel onDecision={onDecision} />);
      fireEvent.click(screen.getByTestId("cloud-sync-signin"));
      await waitFor(() =>
        expect(screen.getByTestId("cloud-sync-repo-input")).toBeInTheDocument(),
      );
      fireEvent.change(screen.getByTestId("cloud-sync-repo-input"), {
        target: { value: "indigoai-us/hq" },
      });
      fireEvent.click(screen.getByTestId("cloud-sync-check"));

      await waitFor(() => {
        expect(screen.getByTestId("cloud-sync-panel")).toHaveAttribute(
          "data-phase",
          "not-found",
        );
      });
      expect(onDecision).toHaveBeenLastCalledWith({ action: "fresh" });
    });

    it("flipping the exists radio from clone to fresh re-emits the fresh decision", async () => {
      const invokeMock = vi.mocked(invoke);
      invokeMock.mockImplementationOnce(async () => ({
        result: "ok",
        info: {
          exists: true,
          last_modified: null,
          estimated_size: null,
        },
      }));

      const onDecision = vi.fn<(d: CloudDecision) => void>();
      render(<CloudSyncPanel onDecision={onDecision} />);
      fireEvent.click(screen.getByTestId("cloud-sync-signin"));
      await waitFor(() =>
        expect(screen.getByTestId("cloud-sync-repo-input")).toBeInTheDocument(),
      );
      fireEvent.change(screen.getByTestId("cloud-sync-repo-input"), {
        target: { value: "indigoai-us/hq" },
      });
      fireEvent.click(screen.getByTestId("cloud-sync-check"));

      await waitFor(() =>
        expect(screen.getByTestId("cloud-sync-panel")).toHaveAttribute(
          "data-phase",
          "exists",
        ),
      );
      fireEvent.click(screen.getByTestId("cloud-sync-choice-fresh"));
      expect(onDecision).toHaveBeenLastCalledWith({ action: "fresh" });
    });

    it("skip link returns to hidden phase and emits fresh decision", async () => {
      const onDecision = vi.fn<(d: CloudDecision) => void>();
      render(<CloudSyncPanel onDecision={onDecision} />);
      fireEvent.click(screen.getByTestId("cloud-sync-signin"));
      await waitFor(() =>
        expect(screen.getByTestId("cloud-sync-panel")).toHaveAttribute(
          "data-phase",
          "signed-in-input",
        ),
      );
      fireEvent.click(screen.getByTestId("cloud-sync-skip"));
      expect(screen.getByTestId("cloud-sync-panel")).toHaveAttribute(
        "data-phase",
        "hidden",
      );
      expect(onDecision).toHaveBeenLastCalledWith({ action: "fresh" });
    });

    it("shows error + retry button when check_cloud_existing fails non-not-found", async () => {
      const invokeMock = vi.mocked(invoke);
      invokeMock.mockImplementationOnce(async () => ({
        result: "err",
        kind: "network-failed",
        message: "DNS lookup failed",
      }));

      render(<CloudSyncPanel onDecision={() => {}} />);
      fireEvent.click(screen.getByTestId("cloud-sync-signin"));
      await waitFor(() =>
        expect(screen.getByTestId("cloud-sync-repo-input")).toBeInTheDocument(),
      );
      fireEvent.change(screen.getByTestId("cloud-sync-repo-input"), {
        target: { value: "indigoai-us/hq" },
      });
      fireEvent.click(screen.getByTestId("cloud-sync-check"));

      await waitFor(() =>
        expect(screen.getByTestId("cloud-sync-error")).toHaveTextContent(
          /DNS lookup failed/,
        ),
      );
      expect(screen.getByTestId("cloud-sync-retry")).toBeInTheDocument();
    });
  });

  describe("LocationRoute end-to-end", () => {
    it("defaults to ~/hq and triggers scaffold_hq on Next click", async () => {
      const onComplete = vi.fn();
      render(<LocationRoute onComplete={onComplete} />);
      expect(
        (screen.getByTestId("location-path-input") as HTMLInputElement).value,
      ).toBe("~/hq");
      fireEvent.click(screen.getByTestId("location-next"));
      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledTimes(1);
      });
      const result = onComplete.mock.calls[0][0];
      expect(result.mode).toBe("scaffold");
      expect(result.target_dir).toBe("/tmp/hq-test");
      expect(result.detail).toBe("abc1234");
    });

    it("shows empty-location warning when path is cleared", () => {
      render(<LocationRoute onComplete={() => {}} />);
      fireEvent.change(screen.getByTestId("location-path-input"), {
        target: { value: "" },
      });
      expect(
        screen.getByTestId("location-empty-warning"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("location-next")).toBeDisabled();
    });

    it("shows OverwriteConfirm on TargetNotEmpty and retries with force=true on confirm", async () => {
      const invokeMock = vi.mocked(invoke);
      // Clear call history from prior tests in this file — we're about to
      // inspect call order to prove force=true is sent on retry, and stale
      // history would make the index math lie.
      invokeMock.mockClear();
      // 1st scaffold call returns target-not-empty; 2nd returns ok.
      invokeMock
        .mockImplementationOnce(async () => ({
          result: "err",
          kind: "target-not-empty",
          message: "target is not empty",
        }))
        .mockImplementationOnce(async () => ({
          result: "ok",
          summary: {
            target_dir: "/tmp/hq-existing",
            file_count: 14,
            duration_ms: 50,
            commit_sha: "def5678",
          },
        }));

      const onComplete = vi.fn();
      render(<LocationRoute onComplete={onComplete} />);
      fireEvent.click(screen.getByTestId("location-next"));

      await waitFor(() => {
        expect(screen.getByTestId("overwrite-confirm")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("overwrite-confirm-proceed"));

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledTimes(1);
      });
      // We should have exactly two scaffold_hq calls; the second carries force=true.
      const scaffoldCalls = invokeMock.mock.calls.filter(
        (c) => c[0] === "scaffold_hq",
      );
      expect(scaffoldCalls.length).toBeGreaterThanOrEqual(2);
      const secondArgs = scaffoldCalls[1]?.[1] as { force: boolean };
      expect(secondArgs.force).toBe(true);
    });

    it("cancelling the overwrite modal returns to idle without calling onComplete", async () => {
      const invokeMock = vi.mocked(invoke);
      invokeMock.mockImplementationOnce(async () => ({
        result: "err",
        kind: "target-not-empty",
        message: "target is not empty",
      }));

      const onComplete = vi.fn();
      render(<LocationRoute onComplete={onComplete} />);
      fireEvent.click(screen.getByTestId("location-next"));

      await waitFor(() => {
        expect(screen.getByTestId("overwrite-confirm")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("overwrite-confirm-cancel"));

      await waitFor(() => {
        expect(screen.getByTestId("location-route")).toHaveAttribute(
          "data-phase",
          "idle",
        );
      });
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("routes clone_cloud_existing when user picks clone from the cloud panel", async () => {
      const invokeMock = vi.mocked(invoke);
      // 1st invoke: check_cloud_existing with exists=true
      invokeMock.mockImplementationOnce(async () => ({
        result: "ok",
        info: {
          exists: true,
          last_modified: "2026-04-14T12:00:00Z",
          estimated_size: 99999,
        },
      }));
      // 2nd invoke: clone_cloud_existing ok
      invokeMock.mockImplementationOnce(async () => ({
        result: "ok",
        summary: {
          target_dir: "/tmp/hq-cloned",
          backend: "github",
          duration_ms: 999,
        },
      }));

      const onComplete = vi.fn();
      render(<LocationRoute onComplete={onComplete} />);
      // Drive the cloud panel to exists → clone decision
      fireEvent.click(screen.getByTestId("cloud-sync-signin"));
      await waitFor(() =>
        expect(
          screen.getByTestId("cloud-sync-repo-input"),
        ).toBeInTheDocument(),
      );
      fireEvent.change(screen.getByTestId("cloud-sync-repo-input"), {
        target: { value: "indigoai-us/hq" },
      });
      fireEvent.click(screen.getByTestId("cloud-sync-check"));
      await waitFor(() =>
        expect(screen.getByTestId("cloud-sync-panel")).toHaveAttribute(
          "data-phase",
          "exists",
        ),
      );

      // Now click Next — should call clone_cloud_existing.
      fireEvent.click(screen.getByTestId("location-next"));
      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledTimes(1);
      });
      const result = onComplete.mock.calls[0][0];
      expect(result.mode).toBe("clone");
      expect(result.target_dir).toBe("/tmp/hq-cloned");
      expect(result.detail).toBe("github");
    });
  });
});
