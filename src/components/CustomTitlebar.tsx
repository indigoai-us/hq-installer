// CustomTitlebar.tsx
// Custom Windows title bar — paired with `"decorations": false` in
// tauri.conf.json. Renders the app icon/title on the draggable strip and
// minimize/maximize/close controls on the right.

import { Minus, Square, X, Copy } from "lucide-react";
import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWindows } from "@/lib/utils";

interface CustomTitlebarProps {
  inTauri: boolean;
}

export function CustomTitlebar({ inTauri }: CustomTitlebarProps) {
  const [maximized, setMaximized] = useState(false);
  const windows = isWindows();
  const canUseWindowControls = inTauri && windows;

  useEffect(() => {
    if (!canUseWindowControls) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized);
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [canUseWindowControls]);

  const onMinimize = () => void getCurrentWindow().minimize();
  const onToggleMax = () => void getCurrentWindow().toggleMaximize();
  const onClose = () => void getCurrentWindow().close();
  const titlebarClassName = windows
    ? `shrink-0 w-full bg-zinc-950/80 flex items-center select-none ${inTauri ? "h-10" : "h-8"}`
    : `shrink-0 w-full bg-zinc-950/80 ${inTauri ? "h-10" : "h-8"}`;

  return (
    <div
      data-testid="titlebar"
      role="banner"
      data-tauri-drag-region
      className={titlebarClassName}
    >
      {windows ? (
        <div
          data-tauri-drag-region
          className="pl-2.5 pr-2 flex items-center gap-2 text-xs font-medium text-zinc-300 tracking-wide pointer-events-none"
        >
          <img
            src="/app-icon.png"
            alt=""
            aria-hidden
            className="w-4 h-4 rounded-sm select-none"
            draggable={false}
          />
          <span>HQ Installer</span>
        </div>
      ) : null}
      {windows ? <div data-tauri-drag-region className="flex-1 h-full" /> : null}
      {canUseWindowControls ? (
        <div className="flex h-full">
          <TitlebarButton onClick={onMinimize} ariaLabel="Minimize">
            <Minus className="w-3.5 h-3.5" />
          </TitlebarButton>
          <TitlebarButton onClick={onToggleMax} ariaLabel={maximized ? "Restore" : "Maximize"}>
            {maximized ? <Copy className="w-3 h-3 rotate-90" /> : <Square className="w-3 h-3" />}
          </TitlebarButton>
          <TitlebarButton onClick={onClose} ariaLabel="Close" danger>
            <X className="w-3.5 h-3.5" />
          </TitlebarButton>
        </div>
      ) : null}
    </div>
  );
}

function TitlebarButton({
  onClick,
  ariaLabel,
  danger,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={`w-11 h-full flex items-center justify-center text-zinc-400 transition-colors ${
        danger ? "hover:bg-red-600 hover:text-white" : "hover:bg-zinc-800 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
