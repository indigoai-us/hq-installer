import { describe, expect, it } from "vitest";
import {
  extractEmailDomain,
  isGenericEmailDomain,
} from "../generic-email-domains";

describe("extractEmailDomain", () => {
  it("returns the lowercased domain for a valid email", () => {
    expect(extractEmailDomain("user@acme.com")).toBe("acme.com");
  });

  it("normalizes uppercase input", () => {
    expect(extractEmailDomain("USER@ACME.COM")).toBe("acme.com");
  });

  it("returns null when there is no @", () => {
    expect(extractEmailDomain("user.acme.com")).toBeNull();
  });

  it("returns null for an empty domain", () => {
    expect(extractEmailDomain("user@")).toBeNull();
  });

  it("uses the substring after the last @", () => {
    expect(extractEmailDomain("a@b@c.com")).toBe("c.com");
  });

  it("preserves subdomains", () => {
    expect(extractEmailDomain("user@mail.acme.com")).toBe("mail.acme.com");
  });

  it("trims surrounding spaces", () => {
    expect(extractEmailDomain("  user@acme.com  ")).toBe("acme.com");
  });

  it("returns null when internal whitespace is present", () => {
    expect(extractEmailDomain("user name@acme.com")).toBeNull();
    expect(extractEmailDomain("user@acme .com")).toBeNull();
  });
});

describe("isGenericEmailDomain", () => {
  it("matches maintained generic domains", () => {
    for (const domain of [
      "gmail.com",
      "outlook.com",
      "yahoo.com",
      "icloud.com",
      "proton.me",
      "aol.com",
      "gmx.com",
      "qq.com",
    ]) {
      expect(isGenericEmailDomain(domain)).toBe(true);
    }
  });

  it("matches case-insensitively", () => {
    expect(isGenericEmailDomain("GMAIL.COM")).toBe(true);
  });

  it("does not match corporate domains", () => {
    expect(isGenericEmailDomain("acme.com")).toBe(false);
  });
});
