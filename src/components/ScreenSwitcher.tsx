// ScreenSwitcher.tsx — wizard step crossfade.
//
// When `stepKey` changes, hold the OLD children in place, animate them out,
// then swap to the NEW children and animate them in. Prop updates on the
// same step (e.g. telemetry toggles) pass through without a transition so
// in-screen interactions stay snappy.

import React, { useEffect, useRef, useState } from "react";

interface Props {
  stepKey: number | string;
  children: React.ReactNode;
  /** Milliseconds for the out half of the crossfade. */
  durationMs?: number;
}

export function ScreenSwitcher({
  stepKey,
  children,
  durationMs = 180,
}: Props) {
  const [display, setDisplay] = useState<{
    key: Props["stepKey"];
    node: React.ReactNode;
  }>(() => ({ key: stepKey, node: children }));
  const [phase, setPhase] = useState<"in" | "out">("in");
  const pendingChildrenRef = useRef(children);
  pendingChildrenRef.current = children;

  useEffect(() => {
    if (display.key === stepKey) {
      if (display.node !== children) {
        setDisplay({ key: stepKey, node: children });
      }
      return;
    }
    setPhase("out");
    const t = window.setTimeout(() => {
      setDisplay({ key: stepKey, node: pendingChildrenRef.current });
      setPhase("in");
    }, durationMs);
    return () => window.clearTimeout(t);
  }, [stepKey, children, display.key, display.node, durationMs]);

  return (
    <div className={phase === "out" ? "hq-screen-out" : "hq-screen-in"}>
      {display.node}
    </div>
  );
}
