import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveUserCompany } from "../vault-handoff";

const MOCK_TOKEN = "mock-access-token";

function mockFetch(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex++];
    return {
      ok: resp.ok,
      status: resp.status,
      json: async () => resp.body,
    } as Response;
  });
}

describe("resolveUserCompany", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns company details when user has a provisioned company", async () => {
    globalThis.fetch = mockFetch([
      // GET /entity/by-type/person → { entities: [...] }
      {
        ok: true,
        status: 200,
        body: {
          entities: [{ uid: "per_001", type: "person", slug: "stefan", name: "Stefan" }],
        },
      },
      // GET /membership/person/{personUid} → { memberships: [...] }
      {
        ok: true,
        status: 200,
        body: {
          memberships: [
            {
              membershipKey: "per_001#cmp_001",
              personUid: "per_001",
              companyUid: "cmp_001",
              role: "admin",
              status: "active",
            },
          ],
        },
      },
      // GET /entity/{companyUid} → { entity: {...} }
      {
        ok: true,
        status: 200,
        body: {
          entity: {
            uid: "cmp_001",
            type: "company",
            slug: "acme",
            name: "Acme Inc",
            metadata: { bucketName: "hq-vault-acme" },
          },
        },
      },
    ]);

    const result = await resolveUserCompany(MOCK_TOKEN);

    expect(result).toEqual({
      found: true,
      companyUid: "cmp_001",
      companySlug: "acme",
      companyName: "Acme Inc",
      bucketName: "hq-vault-acme",
      personUid: "per_001",
      role: "admin",
    });

    // Verify auth header was passed
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    const firstCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(firstCall[1]?.headers).toEqual(
      expect.objectContaining({ Authorization: `Bearer ${MOCK_TOKEN}` })
    );
  });

  it("returns found: false when no person entity exists", async () => {
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, body: { entities: [] } },
    ]);

    const result = await resolveUserCompany(MOCK_TOKEN);
    expect(result).toEqual({ found: false });
  });

  it("returns found: false when person has no memberships", async () => {
    globalThis.fetch = mockFetch([
      {
        ok: true,
        status: 200,
        body: {
          entities: [{ uid: "per_001", type: "person", slug: "stefan", name: "Stefan" }],
        },
      },
      { ok: true, status: 200, body: { memberships: [] } },
    ]);

    const result = await resolveUserCompany(MOCK_TOKEN);
    expect(result).toEqual({ found: false });
  });

  it("throws on network error from person lookup", async () => {
    globalThis.fetch = mockFetch([
      { ok: false, status: 500, body: { error: "Internal server error" } },
    ]);

    await expect(resolveUserCompany(MOCK_TOKEN)).rejects.toThrow(
      "vault-service /entity/by-type/person failed: 500"
    );
  });

  it("throws on network error from membership lookup", async () => {
    globalThis.fetch = mockFetch([
      {
        ok: true,
        status: 200,
        body: {
          entities: [{ uid: "per_001", type: "person", slug: "stefan", name: "Stefan" }],
        },
      },
      { ok: false, status: 403, body: { error: "Forbidden" } },
    ]);

    await expect(resolveUserCompany(MOCK_TOKEN)).rejects.toThrow(
      "vault-service /membership/person/per_001 failed: 403"
    );
  });

  it("throws on network error from company lookup", async () => {
    globalThis.fetch = mockFetch([
      {
        ok: true,
        status: 200,
        body: {
          entities: [{ uid: "per_001", type: "person", slug: "stefan", name: "Stefan" }],
        },
      },
      {
        ok: true,
        status: 200,
        body: {
          memberships: [
            {
              membershipKey: "per_001#cmp_001",
              personUid: "per_001",
              companyUid: "cmp_001",
              role: "member",
              status: "active",
            },
          ],
        },
      },
      { ok: false, status: 404, body: { error: "Not found" } },
    ]);

    await expect(resolveUserCompany(MOCK_TOKEN)).rejects.toThrow(
      "vault-service /entity/cmp_001 failed: 404"
    );
  });

  it("derives bucket name from slug when bucketName is missing", async () => {
    globalThis.fetch = mockFetch([
      {
        ok: true,
        status: 200,
        body: {
          entities: [{ uid: "per_001", type: "person", slug: "stefan", name: "Stefan" }],
        },
      },
      {
        ok: true,
        status: 200,
        body: {
          memberships: [
            {
              membershipKey: "per_001#cmp_001",
              personUid: "per_001",
              companyUid: "cmp_001",
              role: "admin",
              status: "active",
            },
          ],
        },
      },
      {
        ok: true,
        status: 200,
        body: {
          entity: { uid: "cmp_001", type: "company", slug: "acme", name: "Acme Inc" },
        },
      },
    ]);

    const result = await resolveUserCompany(MOCK_TOKEN);
    expect(result).toEqual(
      expect.objectContaining({ found: true, bucketName: "hq-vault-acme" })
    );
  });
});
