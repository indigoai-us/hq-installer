import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the Welcome route on mount", async () => {
    render(<App />);
    // Immediately, before the scan completes, the retro header is visible.
    expect(screen.getByTestId("welcome-route")).toBeInTheDocument();
    expect(screen.getByTestId("retro-header")).toBeInTheDocument();
    expect(screen.getByText(/INDIGO HQ/i)).toBeInTheDocument();
    // Flush pending scan effects so act() is happy on teardown.
    await waitFor(() => {
      expect(screen.getByTestId("welcome-cta-primary")).not.toBeDisabled();
    });
  });

  it("renders the retro primary CTA", async () => {
    render(<App />);
    // CTA starts disabled ("Scanning…") then becomes enabled once the mock
    // invoke() resolves with all deps installed.
    const cta = screen.getByTestId("welcome-cta-primary");
    expect(cta).toBeInTheDocument();
    await waitFor(() => {
      expect(cta).not.toBeDisabled();
    });
    // All eight mock deps report installed → label is "Install HQ".
    expect(cta).toHaveTextContent(/Install HQ/);
  });

  it("renders the secondary developer CTA", async () => {
    render(<App />);
    expect(screen.getByTestId("welcome-cta-secondary")).toBeInTheDocument();
    expect(screen.getByText(/developer — use CLI instead/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("welcome-cta-primary")).not.toBeDisabled();
    });
  });
});
