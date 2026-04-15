/**
 * Terminal-style log panel for the install wizard.
 *
 * Behavior:
 *   - New log entries append to the bottom.
 *   - If the user is already scrolled to the bottom (within a fuzz of
 *     24 px), the panel auto-scrolls to keep new lines in view.
 *   - If the user has scrolled up, auto-scroll is suspended until they
 *     return to the bottom — matches `tail -f` behavior in iTerm.
 *
 * Presentation:
 *   - stdout lines: default zinc
 *   - stderr lines: warm yellow
 *   - system lines: retro cyan accent
 *   - error lines:  red
 */

import { useEffect, useRef, useState } from "react";
import type { LogEntry } from "@/lib/install-state";

interface LiveLogPanelProps {
  logs: LogEntry[];
}

const lineClass: Record<LogEntry["kind"], string> = {
  stdout: "retro-log-line retro-log-line--stdout",
  stderr: "retro-log-line retro-log-line--stderr",
  system: "retro-log-line retro-log-line--system",
  error: "retro-log-line retro-log-line--error",
};

const STICK_THRESHOLD_PX = 24;

const LiveLogPanel = ({ logs }: LiveLogPanelProps) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  // Keep scroll pinned to the bottom whenever new logs arrive — unless
  // the user has scrolled up.
  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, stickToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom <= STICK_THRESHOLD_PX);
  };

  return (
    <div
      className="retro-log-panel"
      role="log"
      aria-live="polite"
      aria-label="Installer live log"
      data-testid="live-log-panel"
      data-stick-to-bottom={stickToBottom}
    >
      <div
        ref={scrollRef}
        className="retro-log-scroll"
        onScroll={handleScroll}
        data-testid="live-log-scroll"
      >
        {logs.length === 0 ? (
          <p className="retro-log-empty" data-testid="live-log-empty">
            Waiting for install output…
          </p>
        ) : (
          logs.map((entry) => (
            <div
              key={entry.seq}
              className={lineClass[entry.kind]}
              data-testid={`live-log-line-${entry.seq}`}
              data-kind={entry.kind}
            >
              {entry.depId && (
                <span className="retro-log-prefix">[{entry.depId}]</span>
              )}
              <span className="retro-log-text">{entry.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LiveLogPanel;
