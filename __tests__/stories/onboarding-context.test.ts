import { describe, it, expect } from "vitest";
import {
  parseOnboardingContext,
  hasOnboardingContext,
  contextLabel,
  ONBOARDING_CONTEXT_STORAGE_KEY,
} from "../../src/lib/onboarding-context.ts";

/**
 * Access-funnel onboarding context capture on the install.getindigo.ai landing
 * page (hq-access-funnel, in-proj-072 installer side). Verifies the pure parser
 * the download page's client script depends on. The contract the funnel sends:
 *   ?company=<companyUid>&companySlug=<slug>&email=<email>&track=onboarding
 */
describe("onboarding-context parser (access-funnel handoff)", () => {
  it("parses a full funnel handoff query string", () => {
    const c = parseOnboardingContext(
      "?company=cmp_01ABC&companySlug=acme&email=ada%40acme.io&track=onboarding",
    );
    expect(c).toEqual({
      company: "cmp_01ABC",
      companySlug: "acme",
      email: "ada@acme.io",
      track: "onboarding",
    });
    expect(hasOnboardingContext(c)).toBe(true);
    expect(contextLabel(c)).toBe("acme");
  });

  it("tolerates a leading '?' or none, and missing optional params", () => {
    const withQ = parseOnboardingContext("?company=cmp_x");
    const without = parseOnboardingContext("company=cmp_x");
    expect(withQ).toEqual(without);
    expect(withQ.company).toBe("cmp_x");
    expect(withQ.companySlug).toBeNull();
    expect(withQ.email).toBeNull();
    // With no slug, the label falls back to the company uid.
    expect(contextLabel(withQ)).toBe("cmp_x");
  });

  it("treats a plain visit (no company) as no-context", () => {
    const c = parseOnboardingContext("?utm_source=x&track=onboarding");
    expect(hasOnboardingContext(c)).toBe(false);
    expect(contextLabel(c)).toBeNull();
  });

  it("normalizes empty / whitespace-only params to null", () => {
    const c = parseOnboardingContext("?company=&companySlug=%20%20&email=");
    expect(c.company).toBeNull();
    expect(c.companySlug).toBeNull();
    expect(c.email).toBeNull();
    expect(hasOnboardingContext(c)).toBe(false);
  });

  it("never throws on malformed input", () => {
    expect(() => parseOnboardingContext("")).not.toThrow();
    expect(() => parseOnboardingContext("?=&=&&%")).not.toThrow();
    // @ts-expect-error — defensive: null is handled even though the type is string
    expect(() => parseOnboardingContext(null)).not.toThrow();
  });

  it("exposes a stable storage key for the client script", () => {
    expect(ONBOARDING_CONTEXT_STORAGE_KEY).toBe("hq-onboarding-context");
  });
});
