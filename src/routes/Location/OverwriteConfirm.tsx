/**
 * OverwriteConfirm modal.
 *
 * Shown when the user clicks "Next" and `scaffold_hq(force=false)` (or
 * `clone_cloud_existing(force=false)`) returns `target-not-empty`. This
 * is the only real "destructive" confirmation in the installer flow —
 * everything else is either idempotent or adds new files.
 *
 * The modal doesn't do the overwrite itself; it just captures the user's
 * intent and bubbles it back to the Location route, which then calls
 * the original command with `force=true`.
 */

interface OverwriteConfirmProps {
  open: boolean;
  targetPath: string;
  onCancel: () => void;
  onConfirm: () => void;
}

const OverwriteConfirm = ({
  open,
  targetPath,
  onCancel,
  onConfirm,
}: OverwriteConfirmProps) => {
  if (!open) return null;

  return (
    <div
      className="retro-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="overwrite-confirm-title"
      data-testid="overwrite-confirm"
    >
      <div className="retro-modal-card">
        <h2
          id="overwrite-confirm-title"
          className="retro-modal-title"
          data-testid="overwrite-confirm-title"
        >
          Target folder is not empty
        </h2>
        <p className="retro-modal-body">
          <code data-testid="overwrite-confirm-path">{targetPath}</code> already
          has files in it. Continuing will overwrite existing files that
          conflict with the HQ template. Files unrelated to HQ will be left
          alone, but there is no undo.
        </p>
        <p className="retro-modal-hint">
          If you're not sure, cancel and pick a different location.
        </p>
        <div className="retro-modal-actions">
          <button
            type="button"
            className="retro-cta-secondary"
            onClick={onCancel}
            data-testid="overwrite-confirm-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="retro-cta-primary"
            onClick={onConfirm}
            data-testid="overwrite-confirm-proceed"
          >
            Overwrite and continue
          </button>
        </div>
      </div>
    </div>
  );
};

export default OverwriteConfirm;
