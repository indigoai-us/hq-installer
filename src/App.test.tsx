import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders Set up HQ heading", () => {
    render(<App />);
    expect(screen.getByText(/Set up HQ/i)).toBeTruthy();
  });

  it("renders Get Started button", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: /Get Started/i })).toBeTruthy();
  });
});
