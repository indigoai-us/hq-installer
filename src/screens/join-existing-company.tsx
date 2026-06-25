// join-existing-company.tsx — US-019
// Conditional organization join offer shown only after the server-side matcher
// returns exactly one joinable company for the signed-in user's verified domain.

import { useState } from "react";
import { WizardFooterSlot } from "@/components/WizardFooter";
import { getCurrentUser } from "@/lib/cognito";
import { requestJoinCompany } from "@/lib/join-suggest";

export interface JoinExistingCompanyProps {
  company: { uid: string; name: string };
  onNext: () => void;
}

type RequestStatus = "idle" | "submitting" | "sent" | "failed";

export function JoinExistingCompany({
  company,
  onNext,
}: JoinExistingCompanyProps) {
  const [status, setStatus] = useState<RequestStatus>("idle");

  async function handleRequest() {
    if (status === "submitting") return;
    setStatus("submitting");

    const user = await getCurrentUser().catch(() => null);
    if (!user) {
      onNext();
      return;
    }

    const result = await requestJoinCompany(
      user.tokens.accessToken,
      company.uid,
    );
    setStatus(result.ok ? "sent" : "failed");
    window.setTimeout(onNext, 900);
  }

  return (
    <section
      data-testid="join-existing-company"
      aria-labelledby="join-existing-company-title"
      className="space-y-8"
    >
      <div className="space-y-4">
        <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">
          Organization
        </p>
        <h1
          id="join-existing-company-title"
          className="text-3xl font-semibold text-white tracking-normal"
        >
          Looks like you belong to {company.name}
        </h1>
        <div className="space-y-3 text-sm leading-6 text-zinc-300 max-w-2xl">
          <p>
            Your verified email domain matches this organization on HQ. You can
            request to join it instead of setting up a separate personal HQ.
          </p>
        </div>
      </div>

      <div
        role="status"
        aria-live="polite"
        className="min-h-6 text-sm text-zinc-300"
      >
        {status === "sent" && "Request sent — your admin will approve it."}
        {status === "failed" &&
          "We couldn't send the request — you can ask your admin for an invite."}
      </div>

      <WizardFooterSlot>
        <button
          type="button"
          data-testid="join-decline"
          onClick={onNext}
          className="rounded-md px-4 py-2 text-sm font-medium text-zinc-300 hover:text-white hover:bg-white/5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
        >
          No thanks, set up my own
        </button>
        <button
          type="button"
          data-testid="join-request"
          onClick={handleRequest}
          disabled={status === "submitting"}
          className="rounded-md bg-white text-black px-5 py-2 text-sm font-medium hover:bg-zinc-200 disabled:opacity-60 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          {status === "submitting"
            ? "Sending request..."
            : `Request to join ${company.name}`}
        </button>
      </WizardFooterSlot>
    </section>
  );
}
