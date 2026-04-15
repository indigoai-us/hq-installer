/**
 * Root app shell. The installer is a linear flow (welcome → install →
 * location → done) so the initial iteration uses a simple discriminated
 * union for routing rather than a full router library — each phase maps
 * to a top-level component.
 */

import { useMemo, useState } from "react";
import Welcome from "@/routes/Welcome";
import InstallRoute from "@/routes/Install";
import LocationRoute, { type LocationResult } from "@/routes/Location";
import type { ScanPayload } from "@/routes/Welcome/SystemScan";
import type { CheckResult, DepId } from "@/lib/tauri-invoke";

type Route =
  | { name: "welcome" }
  | { name: "install-wizard"; scan: ScanPayload }
  | { name: "location-picker"; finalDeps: CheckResult[] }
  | { name: "done"; finalDeps: CheckResult[]; location: LocationResult };

/** Build the queue of deps to install from a Welcome scan payload. */
function deriveMissingQueue(scan: ScanPayload): DepId[] {
  const missing: DepId[] = [];
  for (const r of scan.results) {
    if (!r.installed) missing.push(r.dep_id);
  }
  return missing;
}

function App() {
  const [route, setRoute] = useState<Route>({ name: "welcome" });

  // The welcome scan's missing-dep list is the source of truth for the
  // install wizard queue. Memo'd so a re-render doesn't re-compute.
  const missingQueue = useMemo(
    () => (route.name === "install-wizard" ? deriveMissingQueue(route.scan) : []),
    [route],
  );

  if (route.name === "welcome") {
    return (
      <Welcome
        onBegin={(scan) => {
          const missing = deriveMissingQueue(scan);
          if (missing.length === 0) {
            // Nothing to install — jump straight to the location picker stub.
            setRoute({ name: "location-picker", finalDeps: scan.results });
            return;
          }
          setRoute({ name: "install-wizard", scan });
        }}
      />
    );
  }

  if (route.name === "install-wizard") {
    return (
      <InstallRoute
        initialMissing={missingQueue}
        onComplete={(finalDeps) => setRoute({ name: "location-picker", finalDeps })}
      />
    );
  }

  if (route.name === "location-picker") {
    return (
      <LocationRoute
        onComplete={(location) =>
          setRoute({
            name: "done",
            finalDeps: route.finalDeps,
            location,
          })
        }
      />
    );
  }

  // US-009 (success + handoff) hasn't shipped yet — render a minimal
  // confirmation so the flow lands somewhere visible until then.
  return (
    <main
      className="min-h-screen flex items-center justify-center"
      style={{ backgroundColor: "var(--retro-bg-0)" }}
      data-testid="done-stub"
    >
      <p
        className="font-mono text-sm text-zinc-300"
        data-testid="done-summary"
      >
        HQ ready at <code>{route.location.target_dir}</code> ({route.location.mode}: {route.location.detail}) —{" "}
        {route.finalDeps.length} deps verified.
      </p>
    </main>
  );
}

export default App;
