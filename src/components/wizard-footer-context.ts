import { createContext, useContext } from "react";

interface WizardFooterContextValue {
  footerRef: HTMLDivElement | null;
  setFooterRef: (el: HTMLDivElement | null) => void;
}

export const WizardFooterContext = createContext<WizardFooterContextValue>({
  footerRef: null,
  setFooterRef: () => {},
});

export function useFooterRef() {
  return useContext(WizardFooterContext);
}
