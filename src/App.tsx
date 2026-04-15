/**
 * Root app shell. The installer is a linear flow (welcome → install →
 * location → done) so the initial iteration uses a simple discriminated
 * union for routing rather than a full router library — each phase maps
 * to a top-level component.
 */

import { useState } from "react";
import Welcome from "@/routes/Welcome";
import type { ScanPayload } from "@/routes/Welcome/SystemScan";

type Route =
  | { name: "welcome" }
  | { name: "install-wizard"; scan: ScanPayload };

function App() {
  const [route, setRoute] = useState<Route>({ name: "welcome" });

  if (route.name === "welcome") {
    return (
      <Welcome
        onBegin={(scan) => setRoute({ name: "install-wizard", scan })}
      />
    );
  }

  // Install wizard is implemented in US-007. For now, render a neutral
  // stub acknowledging the handoff — the scan payload is carried forward.
  return (
    <main
      className="min-h-screen flex items-center justify-center"
      style={{ backgroundColor: "var(--retro-bg-0)" }}
      data-testid="install-wizard-stub"
    >
      <p className="font-mono text-sm text-zinc-400">
        Install wizard coming next — carrying {route.scan.results.length}{" "}
        scanned deps forward.
      </p>
    </main>
  );
}

export default App;
