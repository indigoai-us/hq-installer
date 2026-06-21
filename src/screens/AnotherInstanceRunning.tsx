import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";

interface AnotherInstanceRunningProps {
  onPrimaryAcquired: () => void;
}

export function AnotherInstanceRunning({
  onPrimaryAcquired,
}: AnotherInstanceRunningProps) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleCheckAgain() {
    setChecking(true);
    setMessage(null);
    try {
      const isPrimary = await invoke<boolean>("recheck_primary_instance");
      if (isPrimary) {
        onPrimaryAcquired();
        return;
      }
      setMessage("The other installer window is still running.");
    } catch {
      setMessage("Could not check the other installer window.");
    } finally {
      setChecking(false);
    }
  }

  async function handleQuit() {
    try {
      await getCurrentWindow().close();
    } catch {
      window.close();
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="fixed inset-0 bg-black/70 backdrop-blur-[24px]" />
      <main className="relative z-10 flex min-h-screen items-center justify-center px-8">
        <section className="w-full max-w-xl">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <h1 className="text-3xl font-medium text-white">
                HQ Installer is already open
              </h1>
              <p className="font-light leading-relaxed text-zinc-300">
                Another copy of the installer is already running. Switch to that
                window to finish your setup. If you've already closed it, choose
                'Check again' to continue here.
              </p>
            </div>

            {message ? (
              <p className="text-sm font-light text-zinc-400">{message}</p>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                onClick={handleCheckAgain}
                disabled={checking}
              >
                {checking ? "Checking..." : "Check again"}
              </Button>
              <Button type="button" variant="secondary" onClick={handleQuit}>
                Quit this window
              </Button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
