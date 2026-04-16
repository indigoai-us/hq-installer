import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Personalize } from "../09-personalize.js";

// ---------------------------------------------------------------------------
// Personalize screen tests (US-017)
//
// These tests are written BEFORE the implementation exists.
// They will fail until src/screens/09-personalize.tsx is created.
//
// Screen: multi-step form
//   Step 1 — IdentityForm:       name, about, goals (all required)
//   Step 2 — StarterProjectPicker: pick one of 3 projects (required)
//   Step 3 — CustomizationForm:  role-specific fields, then Submit
//
// On submit: calls personalize() from lib/personalize-writer.
// On success: calls onNext().
// On failure: renders an error message.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks — must be declared before component imports
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockResolvedValue(""),
  readDir: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tauri-apps/api/path", () => ({
  resolveResource: vi.fn(async (p: string) => `/resolved/${p}`),
}));

// ---------------------------------------------------------------------------
// personalize-writer mock — isolate screen from real file-system writes
// ---------------------------------------------------------------------------

vi.mock("../../lib/personalize-writer.js", () => ({
  personalize: vi.fn().mockResolvedValue(undefined),
}));

import { personalize } from "../../lib/personalize-writer.js";
const mockPersonalize = vi.mocked(personalize);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the "Next" / "Continue" navigation button on step 1 or 2.
 * Implementations may label it differently.
 */
function findNextButton() {
  return (
    screen.queryByRole("button", { name: /next/i }) ||
    screen.queryByRole("button", { name: /continue/i })
  );
}

/**
 * Find the final "Submit" button on step 3.
 */
function findSubmitButton() {
  return (
    screen.queryByRole("button", { name: /submit/i }) ||
    screen.queryByRole("button", { name: /finish/i }) ||
    screen.queryByRole("button", { name: /personalize/i }) ||
    screen.queryByRole("button", { name: /save/i }) ||
    screen.queryByRole("button", { name: /done/i })
  );
}

/**
 * Fill in the identity fields (step 1) and advance to step 2.
 */
async function fillIdentityAndAdvance(
  user: ReturnType<typeof userEvent.setup>,
  opts: { name?: string; about?: string; goals?: string } = {}
) {
  const name = opts.name ?? "Jane Doe";
  const about = opts.about ?? "Software engineer who loves building tools.";
  const goals = opts.goals ?? "Automate my workflow and ship faster.";

  const nameField =
    screen.queryByLabelText(/\bname\b/i) ||
    screen.queryByPlaceholderText(/\bname\b/i) ||
    screen.queryByLabelText(/full name/i) ||
    screen.queryByPlaceholderText(/full name/i);
  const aboutField =
    screen.queryByLabelText(/about/i) ||
    screen.queryByPlaceholderText(/about/i) ||
    screen.queryByLabelText(/who are you/i) ||
    screen.queryByLabelText(/bio/i);
  const goalsField =
    screen.queryByLabelText(/goals?/i) ||
    screen.queryByPlaceholderText(/goals?/i) ||
    screen.queryByLabelText(/what.*want/i);

  if (nameField) await user.clear(nameField);
  if (nameField) await user.type(nameField, name);
  if (aboutField) await user.clear(aboutField);
  if (aboutField) await user.type(aboutField, about);
  if (goalsField) await user.clear(goalsField);
  if (goalsField) await user.type(goalsField, goals);

  const nextBtn = findNextButton();
  if (nextBtn) await user.click(nextBtn);
}

/**
 * Pick a starter project option (step 2) and advance to step 3.
 * Returns the option slug that was selected.
 */
async function pickProjectAndAdvance(
  user: ReturnType<typeof userEvent.setup>,
  slug: "personal-assistant" | "social-media" | "code-worker" = "personal-assistant"
) {
  // Try radio button, then clickable card/button with matching label text
  const option =
    screen.queryByRole("radio", { name: new RegExp(slug.replace(/-/g, "[ -]"), "i") }) ||
    screen.queryByRole("radio", { name: /personal.assistant/i }) ||
    screen.queryByRole("button", { name: /personal.assistant/i }) ||
    // Fallback: any radio on the page
    document.querySelector<HTMLElement>('input[type="radio"]') ||
    document.querySelector<HTMLElement>('[role="radio"]');

  if (option) await user.click(option);

  const nextBtn = findNextButton();
  if (nextBtn) await user.click(nextBtn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Personalize screen (09-personalize.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPersonalize.mockResolvedValue(undefined);
  });

  // ── 1. Initial render ─────────────────────────────────────────────────────

  describe("initial render", () => {
    it("renders without throwing when Tauri APIs are mocked", () => {
      expect(() => {
        render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      }).not.toThrow();
    });

    it("renders step 1 identity fields on mount", () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      const nameField =
        screen.queryByLabelText(/\bname\b/i) ||
        screen.queryByPlaceholderText(/\bname\b/i) ||
        screen.queryByLabelText(/full name/i);
      const aboutField =
        screen.queryByLabelText(/about/i) ||
        screen.queryByPlaceholderText(/about/i) ||
        screen.queryByLabelText(/bio/i);
      const goalsField =
        screen.queryByLabelText(/goals?/i) ||
        screen.queryByPlaceholderText(/goals?/i);

      // At least the name field must be present on step 1
      expect(nameField || aboutField || goalsField).not.toBeNull();
    });

    it("does NOT call personalize() on mount", () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      expect(mockPersonalize).not.toHaveBeenCalled();
    });

    it("does NOT call onNext() on mount", () => {
      const onNext = vi.fn();
      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);
      expect(onNext).not.toHaveBeenCalled();
    });
  });

  // ── 2. Step 1: IdentityForm — required field validation ───────────────────

  describe("Step 1 — IdentityForm field validation", () => {
    it("Next button is disabled (or absent) when all identity fields are empty", () => {
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      const nextBtn = findNextButton();
      if (nextBtn) {
        // Must be disabled, not just present
        expect((nextBtn as HTMLButtonElement).disabled).toBe(true);
      }
      // Acceptable: button is absent until fields are filled
    });

    it("Next button is disabled when only name is filled", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      const nameField =
        screen.queryByLabelText(/\bname\b/i) ||
        screen.queryByPlaceholderText(/\bname\b/i) ||
        screen.queryByLabelText(/full name/i);

      if (nameField) {
        await user.type(nameField, "Jane Doe");
      }

      const nextBtn = findNextButton();
      if (nextBtn) {
        expect((nextBtn as HTMLButtonElement).disabled).toBe(true);
      }
    });

    it("Next button is enabled when all three identity fields are filled", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      const nameField =
        screen.queryByLabelText(/\bname\b/i) ||
        screen.queryByPlaceholderText(/\bname\b/i) ||
        screen.queryByLabelText(/full name/i);
      const aboutField =
        screen.queryByLabelText(/about/i) ||
        screen.queryByPlaceholderText(/about/i) ||
        screen.queryByLabelText(/bio/i);
      const goalsField =
        screen.queryByLabelText(/goals?/i) ||
        screen.queryByPlaceholderText(/goals?/i);

      if (nameField) await user.type(nameField, "Jane Doe");
      if (aboutField) await user.type(aboutField, "Software engineer.");
      if (goalsField) await user.type(goalsField, "Ship faster.");

      await waitFor(() => {
        const nextBtn = findNextButton();
        if (nextBtn) {
          expect((nextBtn as HTMLButtonElement).disabled).toBe(false);
        }
      });
    });

    it("advancing from step 1 with all fields filled shows step 2 content", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);

      await waitFor(() => {
        // Step 2 must show starter project options
        const text = document.body.textContent ?? "";
        const hasProjectOptions =
          text.match(/personal.assistant|social.media|code.worker|starter.project|choose.*project/i) !== null ||
          document.querySelector('input[type="radio"]') !== null ||
          document.querySelector('[role="radio"]') !== null;
        expect(hasProjectOptions).toBe(true);
      });
    });
  });

  // ── 3. Step 2: StarterProjectPicker — pick one to advance ─────────────────

  describe("Step 2 — StarterProjectPicker", () => {
    it("shows three project options", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);

      await waitFor(() => {
        const radios = document.querySelectorAll('input[type="radio"], [role="radio"]');
        expect(radios.length).toBe(3);
      });
    });

    it("shows a 'personal-assistant' option", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);

      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toMatch(/personal.assistant/i);
      });
    });

    it("shows a 'social-media' option", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);

      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toMatch(/social.media/i);
      });
    });

    it("shows a 'code-worker' option", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);

      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toMatch(/code.worker/i);
      });
    });

    it("Next button is disabled (or absent) until a project is selected", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);

      // After navigating to step 2, Next should be disabled until a choice is made
      await waitFor(() => {
        const nextBtn = findNextButton();
        if (nextBtn) {
          expect((nextBtn as HTMLButtonElement).disabled).toBe(true);
        }
      });
    });

    it("Next button is enabled after selecting a project", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);

      await waitFor(() => {
        const radios = document.querySelectorAll('input[type="radio"], [role="radio"]');
        expect(radios.length).toBeGreaterThan(0);
      });

      // Click the first available option
      const firstOption =
        document.querySelector<HTMLElement>('input[type="radio"]') ||
        document.querySelector<HTMLElement>('[role="radio"]');
      if (firstOption) await user.click(firstOption);

      await waitFor(() => {
        const nextBtn = findNextButton();
        if (nextBtn) {
          expect((nextBtn as HTMLButtonElement).disabled).toBe(false);
        }
      });
    });

    it("advancing to step 3 shows customization fields", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);
      await pickProjectAndAdvance(user);

      await waitFor(() => {
        // Step 3 must show either customization fields or a submit button
        const hasStep3 =
          findSubmitButton() !== null ||
          document.querySelector("textarea") !== null ||
          document.querySelectorAll('input[type="text"]').length > 0;
        expect(hasStep3).toBe(true);
      });
    });
  });

  // ── 4. Step 3: CustomizationForm — submit calls personalize() ─────────────

  describe("Step 3 — CustomizationForm submit", () => {
    it("shows a Submit button on step 3", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);
      await pickProjectAndAdvance(user);

      await waitFor(() => {
        expect(findSubmitButton()).not.toBeNull();
      });
    });

    it("clicking Submit calls personalize() with the identity answers", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user, {
        name: "Jane Doe",
        about: "Software engineer.",
        goals: "Ship faster.",
      });
      await pickProjectAndAdvance(user, "personal-assistant");

      await waitFor(() => expect(findSubmitButton()).not.toBeNull());
      await user.click(findSubmitButton()!);

      await waitFor(() => {
        expect(mockPersonalize).toHaveBeenCalledTimes(1);
        const [answers] = mockPersonalize.mock.calls[0];
        expect(answers.name).toBe("Jane Doe");
        expect(answers.about).toBe("Software engineer.");
        expect(answers.goals).toBe("Ship faster.");
      });
    });

    it("clicking Submit calls personalize() with the correct starterProject slug", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);
      await pickProjectAndAdvance(user, "personal-assistant");

      await waitFor(() => expect(findSubmitButton()).not.toBeNull());
      await user.click(findSubmitButton()!);

      await waitFor(() => {
        expect(mockPersonalize).toHaveBeenCalledTimes(1);
        const [answers] = mockPersonalize.mock.calls[0];
        expect(["personal-assistant", "social-media", "code-worker"]).toContain(answers.starterProject);
      });
    });

    it("clicking Submit passes installPath as baseDir to personalize()", async () => {
      const user = userEvent.setup();
      render(<Personalize installPath="/custom/install/path" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);
      await pickProjectAndAdvance(user);

      await waitFor(() => expect(findSubmitButton()).not.toBeNull());
      await user.click(findSubmitButton()!);

      await waitFor(() => {
        expect(mockPersonalize).toHaveBeenCalledTimes(1);
        const [, baseDir] = mockPersonalize.mock.calls[0];
        expect(baseDir).toBe("/custom/install/path");
      });
    });

    it("calls onNext() after successful submit", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);

      await fillIdentityAndAdvance(user);
      await pickProjectAndAdvance(user);

      await waitFor(() => expect(findSubmitButton()).not.toBeNull());
      await user.click(findSubmitButton()!);

      await waitFor(() => {
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    });

    it("calls onNext() only after personalize() resolves (not before)", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      const callOrder: string[] = [];

      mockPersonalize.mockImplementationOnce(async () => {
        callOrder.push("personalize");
      });
      onNext.mockImplementation(() => {
        callOrder.push("onNext");
      });

      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);

      await fillIdentityAndAdvance(user);
      await pickProjectAndAdvance(user);

      await waitFor(() => expect(findSubmitButton()).not.toBeNull());
      await user.click(findSubmitButton()!);

      await waitFor(() => expect(onNext).toHaveBeenCalled());
      expect(callOrder).toEqual(["personalize", "onNext"]);
    });
  });

  // ── 5. Error state — personalize() rejects ────────────────────────────────

  describe("error state", () => {
    it("shows an error message when personalize() rejects", async () => {
      const user = userEvent.setup();
      mockPersonalize.mockRejectedValueOnce(new Error("Disk write failed"));

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);
      await pickProjectAndAdvance(user);

      await waitFor(() => expect(findSubmitButton()).not.toBeNull());
      await user.click(findSubmitButton()!);

      await waitFor(() => {
        const alert = screen.queryByRole("alert");
        const errorText = screen.queryByText(/error|failed|unable|problem|went wrong/i);
        expect(alert || errorText).not.toBeNull();
      });
    });

    it("does NOT call onNext() when personalize() rejects", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      mockPersonalize.mockRejectedValueOnce(new Error("Disk write failed"));

      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);

      await fillIdentityAndAdvance(user);
      await pickProjectAndAdvance(user);

      await waitFor(() => expect(findSubmitButton()).not.toBeNull());
      await user.click(findSubmitButton()!);

      // Wait for the rejection to be handled
      await waitFor(() => {
        const alert = screen.queryByRole("alert");
        const errorText = screen.queryByText(/error|failed|unable|problem|went wrong/i);
        expect(alert || errorText).not.toBeNull();
      });

      expect(onNext).not.toHaveBeenCalled();
    });

    it("surfaces the error message text in the UI", async () => {
      const user = userEvent.setup();
      mockPersonalize.mockRejectedValueOnce(new Error("Permission denied: /tmp/hq"));

      render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);

      await fillIdentityAndAdvance(user);
      await pickProjectAndAdvance(user);

      await waitFor(() => expect(findSubmitButton()).not.toBeNull());
      await user.click(findSubmitButton()!);

      await waitFor(() => {
        const text = document.body.textContent ?? "";
        // Either the specific error message or a generic error indicator
        expect(
          text.match(/permission denied|failed|error|unable|went wrong/i) !== null
        ).toBe(true);
      });
    });
  });

  // ── 6. UI policy — no-purple-monochrome-ui ────────────────────────────────

  describe("UI policy — no-purple-monochrome-ui", () => {
    it("does NOT use 'purple' class names in the DOM", () => {
      const { container } = render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("does NOT use 'indigo' class names in the DOM", () => {
      const { container } = render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bindigo\b/);
    });
  });

  // ── 7. Tauri environment compatibility ────────────────────────────────────

  describe("Tauri environment compatibility", () => {
    it("renders cleanly when Tauri APIs are mocked", () => {
      expect(() => {
        render(<Personalize installPath="/tmp/hq" onNext={vi.fn()} />);
      }).not.toThrow();
    });

    it("does NOT call onNext on initial render", () => {
      const onNext = vi.fn();
      render(<Personalize installPath="/tmp/hq" onNext={onNext} />);
      expect(onNext).not.toHaveBeenCalled();
    });
  });
});
