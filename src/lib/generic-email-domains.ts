// generic-email-domains.ts — US-019
// Conservative public-consumer email domain guard used before join lookup.

// A false-include here can become a privacy leak by probing shared public
// domains, so keep this set conservative, lowercased, and actively maintained.
export const GENERIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
  "gmx.net",
  "qq.com",
  "163.com",
  "126.com",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "mail.com",
  "fastmail.com",
  "hey.com",
  "pm.me",
  "hotmail.fr",
  "live.co.uk",
]);

export function extractEmailDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  if (/\s/.test(trimmed)) return null;

  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;

  const domain = trimmed.slice(at + 1);
  return domain.length > 0 ? domain : null;
}

export function isGenericEmailDomain(domain: string): boolean {
  return GENERIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}
