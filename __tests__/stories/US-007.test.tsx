import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { existsSync } from "fs";
import { join } from "path";
import DepInstallRow from "@/routes/Install/DepInstallRow";
import LiveLogPanel from "@/routes/Install/LiveLogPanel";
import NodeManualModal from "@/routes/Install/NodeManualModal";
import InstallRoute from "@/routes/Install";
import {
  initialInstallState,
  installReducer,
  completedCount,
  nextPendingDep,
  queueDrained,
  type LogEntry,
} from "@/lib/install-state";
import { invoke } from "@tauri-apps/api/core";

const repoRoot = process.cwd();

/**
 * US-007: Install wizard with live logs.
 *
 * Split across:
 *   1. File scaffold (routes/Install/*, lib/install-state.ts)
 *   2. State machine unit tests (pure reducer)
 *   3. Component render tests (DepInstallRow, LiveLogPanel, NodeManualModal)
 *   4. End-to-end wizard tests with mocked invoke (happy path, failure retry,
 *      skip, node manual modal)
 */
describe("US-007: Install wizard with live logs", () => {
  describe("File scaffold", () => {
    it("install route files all exist", () => {
      const paths = [
        "src/routes/Install/index.tsx",
        "src/routes/Install/DepInstallRow.tsx",
        "src/routes/Install/LiveLogPanel.tsx",
        "src/routes/Install/NodeManualModal.tsx",
        "src/lib/install-state.ts",
      ];
      for (const p of paths) {
        expect(existsSync(join(repoRoot, p))).toBe(true);
      }
    });
  });

  describe("install-state reducer", () => {
    it("initialInstallState seeds every dep as pending", () => {
      const state = initialInstallState(["node", "git"]);
      expect(state.queue).toEqual(["node", "git"]);
      expect(state.status.node).toBe("pending");
      expect(state.status.git).toBe("pending");
      expect(state.currentDepId).toBeNull();
      expect(state.completed).toBe(false);
    });

    it("empty queue is immediately complete", () => {
      const state = initialInstallState([]);
      expect(state.completed).toBe(true);
    });

    it("'start' moves a dep to installing and logs a system line", () => {
      let s = initialInstallState(["node"]);
      s = installReducer(s, { type: "start", depId: "node" });
      expect(s.status.node).toBe("installing");
      expect(s.currentDepId).toBe("node");
      expect(s.logs[0]?.kind).toBe("system");
      expect(s.logs[0]?.text).toMatch(/installing node/i);
    });

    it("stdout + stderr events append typed log entries", () => {
      let s = initialInstallState(["node"]);
      s = installReducer(s, { type: "start", depId: "node" });
      s = installReducer(s, {
        type: "log-stdout",
        depId: "node",
        line: "==> Downloading",
      });
      s = installReducer(s, {
        type: "log-stderr",
        depId: "node",
        line: "warn: prebuild missing",
      });
      const byKind = (k: LogEntry["kind"]) =>
        s.logs.filter((e) => e.kind === k);
      expect(byKind("stdout")[0]?.text).toBe("==> Downloading");
      expect(byKind("stderr")[0]?.text).toBe("warn: prebuild missing");
    });

    it("'finish' with auto exit 0 marks dep done and clears current", () => {
      let s = initialInstallState(["node"]);
      s = installReducer(s, { type: "start", depId: "node" });
      s = installReducer(s, {
        type: "finish",
        depId: "node",
        outcome: { result: "auto", command: "brew install node", exit_code: 0 },
      });
      expect(s.status.node).toBe("done");
      expect(s.currentDepId).toBeNull();
      expect(s.error).toBeNull();
    });

    it("'finish' with auto non-zero exit halts with an error", () => {
      let s = initialInstallState(["git"]);
      s = installReducer(s, { type: "start", depId: "git" });
      s = installReducer(s, {
        type: "finish",
        depId: "git",
        outcome: { result: "auto", command: "brew install git", exit_code: 1 },
      });
      expect(s.status.git).toBe("failed");
      expect(s.error?.depId).toBe("git");
      expect(s.error?.manual).toBe(false);
      expect(s.error?.exitCode).toBe(1);
    });

    it("'finish' with manual outcome flags manual=true on the error", () => {
      let s = initialInstallState(["node"]);
      s = installReducer(s, { type: "start", depId: "node" });
      s = installReducer(s, {
        type: "finish",
        depId: "node",
        outcome: { result: "manual", hint: "Visit https://nodejs.org" },
      });
      expect(s.status.node).toBe("failed");
      expect(s.error?.manual).toBe(true);
      expect(s.error?.message).toMatch(/nodejs\.org/);
    });

    it("'retry' clears error and resets dep to pending", () => {
      let s = initialInstallState(["gh"]);
      s = installReducer(s, { type: "start", depId: "gh" });
      s = installReducer(s, {
        type: "finish",
        depId: "gh",
        outcome: { result: "auto", command: "brew install gh", exit_code: 3 },
      });
      expect(s.error).not.toBeNull();
      s = installReducer(s, { type: "retry", depId: "gh" });
      expect(s.status.gh).toBe("pending");
      expect(s.error).toBeNull();
    });

    it("'skip' marks dep skipped + clears error", () => {
      let s = initialInstallState(["yq"]);
      s = installReducer(s, { type: "start", depId: "yq" });
      s = installReducer(s, {
        type: "finish",
        depId: "yq",
        outcome: { result: "auto", command: "brew install yq", exit_code: 2 },
      });
      s = installReducer(s, { type: "skip", depId: "yq" });
      expect(s.status.yq).toBe("skipped");
      expect(s.error).toBeNull();
    });

    it("completedCount + queueDrained reflect terminal states", () => {
      let s = initialInstallState(["node", "git", "gh"]);
      expect(completedCount(s)).toBe(0);
      expect(queueDrained(s)).toBe(false);

      s = installReducer(s, { type: "start", depId: "node" });
      s = installReducer(s, {
        type: "finish",
        depId: "node",
        outcome: { result: "auto", command: "…", exit_code: 0 },
      });
      expect(completedCount(s)).toBe(1);
      expect(queueDrained(s)).toBe(false);

      s = installReducer(s, { type: "skip", depId: "git" });
      s = installReducer(s, { type: "start", depId: "gh" });
      s = installReducer(s, {
        type: "finish",
        depId: "gh",
        outcome: { result: "auto", command: "…", exit_code: 0 },
      });
      expect(queueDrained(s)).toBe(true);
      expect(nextPendingDep(s)).toBeNull();
    });
  });

  describe("DepInstallRow", () => {
    it("renders pending glyph and label", () => {
      render(<DepInstallRow depId="node" status="pending" />);
      const row = screen.getByTestId("install-row-node");
      expect(row).toHaveAttribute("data-status", "pending");
      expect(row).toHaveTextContent("Node.js");
      expect(row).toHaveTextContent("queued");
    });

    it("renders installing pulse and running label", () => {
      render(<DepInstallRow depId="git" status="installing" />);
      expect(screen.getByTestId("install-row-git")).toHaveAttribute(
        "data-status",
        "installing",
      );
      expect(screen.getByText(/running/i)).toBeInTheDocument();
    });

    it("shows retry + skip buttons when failed and fires callbacks", () => {
      const onRetry = vi.fn();
      const onSkip = vi.fn();
      render(
        <DepInstallRow
          depId="gh"
          status="failed"
          onRetry={onRetry}
          onSkip={onSkip}
        />,
      );
      const retryBtn = screen.getByTestId("retry-gh");
      const skipBtn = screen.getByTestId("skip-gh");
      fireEvent.click(retryBtn);
      fireEvent.click(skipBtn);
      expect(onRetry).toHaveBeenCalledWith("gh");
      expect(onSkip).toHaveBeenCalledWith("gh");
    });
  });

  describe("LiveLogPanel", () => {
    it("shows empty placeholder when no logs", () => {
      render(<LiveLogPanel logs={[]} />);
      expect(screen.getByTestId("live-log-empty")).toBeInTheDocument();
    });

    it("renders a line per log entry with dep prefix", () => {
      const logs: LogEntry[] = [
        { seq: 0, depId: "node", kind: "system", text: "▸ installing node…", ts: 0 },
        { seq: 1, depId: "node", kind: "stdout", text: "==> Downloading", ts: 1 },
        { seq: 2, depId: "node", kind: "stderr", text: "warn: missing prebuild", ts: 2 },
        { seq: 3, depId: null, kind: "error", text: "invoke error: ...", ts: 3 },
      ];
      render(<LiveLogPanel logs={logs} />);
      expect(screen.getByTestId("live-log-line-0")).toHaveAttribute(
        "data-kind",
        "system",
      );
      expect(screen.getByTestId("live-log-line-1")).toHaveTextContent(
        "Downloading",
      );
      expect(screen.getByTestId("live-log-line-2")).toHaveAttribute(
        "data-kind",
        "stderr",
      );
      expect(screen.getByTestId("live-log-line-3")).toHaveAttribute(
        "data-kind",
        "error",
      );
    });
  });

  describe("NodeManualModal", () => {
    it("renders nothing when closed", () => {
      const { container } = render(
        <NodeManualModal open={false} onClose={() => {}} onRecheck={() => {}} />,
      );
      expect(container.innerHTML).toBe("");
    });

    it("renders dialog + actions when open", () => {
      render(
        <NodeManualModal
          open
          onClose={() => {}}
          onRecheck={() => {}}
          hint="https://nodejs.org"
        />,
      );
      expect(screen.getByTestId("node-manual-modal")).toBeInTheDocument();
      expect(screen.getByTestId("node-manual-open")).toBeInTheDocument();
      expect(screen.getByTestId("node-manual-recheck")).toBeInTheDocument();
      expect(screen.getByTestId("node-manual-close")).toBeInTheDocument();
      expect(screen.getByTestId("node-manual-modal-hint")).toHaveTextContent(
        "nodejs.org",
      );
    });

    it("fires callbacks on button click", () => {
      const onClose = vi.fn();
      const onRecheck = vi.fn();
      render(
        <NodeManualModal open onClose={onClose} onRecheck={onRecheck} />,
      );
      fireEvent.click(screen.getByTestId("node-manual-recheck"));
      fireEvent.click(screen.getByTestId("node-manual-close"));
      expect(onRecheck).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("InstallRoute wizard (happy path + retry + skip)", () => {
    it("runs every queued dep sequentially to completion", async () => {
      // The shared mock returns `auto` + exit 0 for install_dep.
      const onComplete = vi.fn();
      render(
        <InstallRoute
          initialMissing={["node", "git"]}
          onComplete={onComplete}
        />,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId("install-row-node"),
        ).toHaveAttribute("data-status", "done");
      });
      await waitFor(() => {
        expect(
          screen.getByTestId("install-row-git"),
        ).toHaveAttribute("data-status", "done");
      });
      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledTimes(1);
      });
      const root = screen.getByTestId("install-route");
      expect(root).toHaveAttribute("data-phase", "complete");
    });

    it("halts on non-zero exit and exposes Retry + Skip on the failed row", async () => {
      const invokeMock = vi.mocked(invoke);
      // First install_dep call → fail.
      invokeMock.mockImplementationOnce(async () => ({
        result: "auto",
        command: "brew install gh",
        exit_code: 1,
      }));
      render(<InstallRoute initialMissing={["gh"]} />);
      await waitFor(() => {
        expect(
          screen.getByTestId("install-row-gh"),
        ).toHaveAttribute("data-status", "failed");
      });
      expect(screen.getByTestId("retry-gh")).toBeInTheDocument();
      expect(screen.getByTestId("skip-gh")).toBeInTheDocument();
      const root = screen.getByTestId("install-route");
      expect(root).toHaveAttribute("data-phase", "error");
    });

    it("Skip moves the failed dep to skipped and completes the wizard", async () => {
      const invokeMock = vi.mocked(invoke);
      invokeMock.mockImplementationOnce(async () => ({
        result: "auto",
        command: "brew install yq",
        exit_code: 4,
      }));
      const onComplete = vi.fn();
      render(
        <InstallRoute initialMissing={["yq"]} onComplete={onComplete} />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("skip-yq")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("skip-yq"));
      await waitFor(() => {
        expect(
          screen.getByTestId("install-row-yq"),
        ).toHaveAttribute("data-status", "skipped");
      });
      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledTimes(1);
      });
    });

    it("opens the Node manual modal when install_dep returns manual for node", async () => {
      const invokeMock = vi.mocked(invoke);
      invokeMock.mockImplementationOnce(async () => ({
        result: "manual",
        hint: "https://nodejs.org/en/download",
      }));
      render(<InstallRoute initialMissing={["node"]} />);
      await waitFor(() => {
        expect(screen.getByTestId("node-manual-modal")).toBeInTheDocument();
      });
      expect(screen.getByTestId("node-manual-modal-hint")).toHaveTextContent(
        "nodejs.org",
      );
    });
  });
});
