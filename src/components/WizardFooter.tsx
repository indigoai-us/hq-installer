import React, { useState, useEffect, useContext } from "react";
import { createPortal } from "react-dom";
import { WizardFooterContext } from "./wizard-footer-context";

export function WizardFooterProvider({ children }: { children: React.ReactNode }) {
  const [footerRef, setFooterRef] = useState<HTMLDivElement | null>(null);
  return (
    <WizardFooterContext.Provider value={{ footerRef, setFooterRef }}>
      {children}
    </WizardFooterContext.Provider>
  );
}

export function WizardFooterSlot({ children }: { children: React.ReactNode }) {
  const { footerRef } = useContext(WizardFooterContext);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (footerRef) setMounted(true);
  }, [footerRef]);

  if (!footerRef || !mounted) return <>{children}</>;
  return createPortal(children, footerRef);
}
