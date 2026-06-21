import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearWizardState, setTelemetryEnabled } from "@/lib/wizard-state";
import App from "./App";

const invokeMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: closeMock,
  }),
}));

describe("App", () => {
  beforeEach(() => {
    clearWizardState();
    setTelemetryEnabled(false);
    invokeMock.mockReset();
    closeMock.mockReset();
    invokeMock.mockResolvedValue(true);
  });

  it("renders Set up HQ heading when this is the primary instance", async () => {
    render(<App />);
    expect(await screen.findByText(/Set up HQ/i)).toBeTruthy();
  });

  it("renders Get Started button when this is the primary instance", async () => {
    render(<App />);
    expect(
      await screen.findByRole("button", { name: /Get Started/i }),
    ).toBeTruthy();
  });

  it("renders the blocking secondary-instance screen when this is not primary", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "is_primary_instance") return Promise.resolve(false);
      return Promise.resolve(true);
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: /HQ Installer is already open/i,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Set up HQ/i)).toBeNull();
  });

  it("continues into the wizard when Check again acquires primary status", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "is_primary_instance") return Promise.resolve(false);
      if (command === "recheck_primary_instance") return Promise.resolve(true);
      return Promise.resolve(true);
    });

    render(<App />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Check again/i }),
    );

    expect(await screen.findByText(/Set up HQ/i)).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("recheck_primary_instance");
  });
});
