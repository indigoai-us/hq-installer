import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { clearWizardState, setInstallPath } from "../../lib/wizard-state.js";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const mockInvoke = vi.mocked(invoke);

function ThrowingChild(): null {
  throw new Error("render exploded");
}

describe("ErrorBoundary", () => {
  const originalConsoleError = console.error;
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearWizardState();
    setInstallPath("/Users/testuser/HQ");
    console.error = vi.fn();
    reloadSpy = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    console.error = originalConsoleError;
    clearWizardState();
  });

  it("renders recovery UI and starts over via reload", async () => {
    const user = userEvent.setup();

    render(
      <ErrorBoundary reload={reloadSpy}>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(
      screen.getByRole("heading", { name: /something went wrong/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("render exploded")).toBeInTheDocument();
    expect(screen.getByText("/Users/testuser/HQ")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /start over/i }));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("reveals the recovered HQ folder", async () => {
    const user = userEvent.setup();

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    await user.click(
      screen.getByRole("button", { name: /reveal hq folder in finder/i }),
    );

    expect(mockInvoke).toHaveBeenCalledWith("reveal_folder", {
      path: "/Users/testuser/HQ",
    });
  });
});
