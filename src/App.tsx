/**
 * Root app shell. The installer is a linear flow (welcome → install →
 * location → done) so the initial iteration uses a simple discriminated
 * union for routing rather than a full router library — each phase maps
 * to a top-level component.
 */

import { useMemo, useRef, useState } from "react";
import Welcome from "@/routes/Welcome";
import InstallRoute from "@/routes/Install";
import LocationRoute, { type LocationResult } from "@/routes/Location";
import SuccessRoute from "@/routes/Success";
import type { ScanPayload } from "@/routes/Welcome/SystemScan";
import type { CheckResult, DepId } from "@/lib/tauri-invoke";

type Route =
  | { name: "welcome" }
  | { name: "install-wizard"; scan: ScanPayload }
  | { name: "location-picker"; finalDeps: CheckResult[] }
  | {
      name: "done";
      finalDeps: CheckResult[];
      location: LocationResult;
      durationSeconds: number;
    };

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

  // Stamp when the user clicks "Begin install" on Welcome. This is the
  // clock that ends on the Success screen — we deliberately exclude the
  // time spent *reading* the welcome splash from the displayed duration.
  // `useRef` rather than state so re-renders don't reset it and setting
  // it from an event handler doesn't trigger a re-render of its own.
  const installStartedAtRef = useRef<number | null>(null);

  // The welcome scan's missing-dep list is the source of truth for the
  // install wizard queue. Memo'd so a re-render doesn't re-compute.
  const missingQueue = useMemo(
    () => (route.name === "install-wizard" ? deriveMissingQueue(route.scan) : []),
    [route],
  );

  /** Compute elapsed seconds since the install flow began, clamped to ≥0. */
  const elapsedSeconds = (): number => {
    const start = installStartedAtRef.current;
    if (start === null) return 0;
    return Math.max(0, Math.round((Date.now() - start) / 1000));
  };

  if (route.name === "welcome") {
    return (
      <Welcome
        onBegin={(scan) => {
          // Start the install timer the moment we leave the welcome screen.
          installStartedAtRef.current = Date.now();
          const missing = deriveMissingQueue(scan);
          if (missing.length === 0) {
            // Nothing to install — jump straight to the location picker.
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
            durationSeconds: elapsedSeconds(),
          })
        }
      />
    );
  }

  // US-009 — success screen with open-in-claude-code handoff + confetti.
  return (
    <SuccessRoute
      location={route.location}
      finalDeps={route.finalDeps}
      durationSeconds={route.durationSeconds}
    />
  );
}

export default App;
