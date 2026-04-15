/**
 * Node.js manual-install modal.
 *
 * Node.js is the one dependency the installer won't try to auto-install
 * on macOS because the right install method is controversial (system
 * Homebrew, nvm, fnm, asdf, volta, or the binary installer from
 * nodejs.org). Instead of picking a fight, we open nodejs.org in the
 * system browser and ask the user to re-run detection when they're done.
 *
 * Triggered from the install wizard when the Rust runner reports a
 * `manual` outcome on the Node.js dep.
 */

import { useCallback } from "react";
import { open as openShellPath } from "@tauri-apps/plugin-shell";

interface NodeManualModalProps {
  open: boolean;
  onClose: () => void;
  onRecheck: () => void;
  hint?: string;
}

const NODE_DOWNLOAD_URL = "https://nodejs.org/en/download";

const NodeManualModal = ({
  open,
  onClose,
  onRecheck,
  hint,
}: NodeManualModalProps) => {
  const handleOpen = useCallback(async () => {
    try {
      await openShellPath(NODE_DOWNLOAD_URL);
    } catch {
      // Ignore — the shell plugin can error inside a sandboxed webview.
      // Leave the modal open so the user can read the hint + URL manually.
    }
  }, []);

  if (!open) return null;

  return (
    <div
      className="retro-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="node-manual-modal-title"
      data-testid="node-manual-modal"
    >
      <div className="retro-modal-card">
        <h2
          id="node-manual-modal-title"
          className="retro-modal-title"
          data-testid="node-manual-modal-title"
        >
          Install Node.js manually
        </h2>
        <p className="retro-modal-body">
          HQ needs Node.js but the installer won't pick a package manager
          for you. Open nodejs.org, run the installer for your platform,
          then come back and click <strong>Recheck</strong>.
        </p>
        {hint && (
          <p
            className="retro-modal-hint"
            data-testid="node-manual-modal-hint"
          >
            {hint}
          </p>
        )}
        <div className="retro-modal-actions">
          <button
            type="button"
            className="retro-cta-primary"
            onClick={handleOpen}
            data-testid="node-manual-open"
          >
            Open nodejs.org
          </button>
          <button
            type="button"
            className="retro-cta-primary retro-cta-primary--secondary"
            onClick={onRecheck}
            data-testid="node-manual-recheck"
          >
            Recheck
          </button>
          <button
            type="button"
            className="retro-cta-secondary"
            onClick={onClose}
            data-testid="node-manual-close"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default NodeManualModal;
