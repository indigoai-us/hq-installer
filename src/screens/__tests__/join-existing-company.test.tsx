import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JoinExistingCompany } from "../join-existing-company";
import { getCurrentUser } from "@/lib/cognito";
import { requestJoinCompany } from "@/lib/join-suggest";

vi.mock("@/lib/cognito", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/lib/join-suggest", () => ({
  requestJoinCompany: vi.fn(),
}));

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockRequestJoinCompany = vi.mocked(requestJoinCompany);

describe("JoinExistingCompany", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({
      sub: "sub_1",
      email: "user@acme.com",
      tokens: {
        accessToken: "tok",
        idToken: "id",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
      },
    });
    mockRequestJoinCompany.mockResolvedValue({ ok: true });
  });

  it("renders the company name", () => {
    render(
      <JoinExistingCompany
        company={{ uid: "cmp_1", name: "Acme" }}
        onNext={vi.fn()}
      />,
    );

    expect(screen.getByText(/looks like you belong to acme/i)).toBeInTheDocument();
  });

  it("requests access and then advances", async () => {
    const onNext = vi.fn();
    render(
      <JoinExistingCompany
        company={{ uid: "cmp_1", name: "Acme" }}
        onNext={onNext}
      />,
    );

    await userEvent.click(screen.getByTestId("join-request"));

    await waitFor(() =>
      expect(mockRequestJoinCompany).toHaveBeenCalledWith("tok", "cmp_1"),
    );
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), {
      timeout: 1500,
    });
  });

  it("declines without requesting access", async () => {
    const onNext = vi.fn();
    render(
      <JoinExistingCompany
        company={{ uid: "cmp_1", name: "Acme" }}
        onNext={onNext}
      />,
    );

    await userEvent.click(screen.getByTestId("join-decline"));

    expect(mockRequestJoinCompany).not.toHaveBeenCalled();
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
