import { describe, expect, it, vi } from "vitest";
import {
  fetchJoinSuggestion,
  requestJoinCompany,
} from "../join-suggest";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("fetchJoinSuggestion", () => {
  it("skips network calls for generic domains", async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchJoinSuggestion("tok", "user@gmail.com", {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({ match: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a strict match and sends no email or domain", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          match: true,
          company: { uid: "cmp_1", name: "Acme" },
        }),
    );

    await expect(
      fetchJoinSuggestion("tok", "user@acme.com", {
        fetchImpl: fetchImpl as typeof fetch,
        baseUrl: "https://example.test/",
      }),
    ).resolves.toEqual({
      match: true,
      company: { uid: "cmp_1", name: "Acme" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.test/membership/suggest-join");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    expect(init?.body).toBe("{}");
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("domain");
  });

  it("returns no match for a neutral server response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ match: false }));

    await expect(
      fetchJoinSuggestion("tok", "user@acme.com", {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({ match: false });
  });

  it("returns no match for non-2xx statuses", async () => {
    for (const status of [404, 500]) {
      const fetchImpl = vi.fn(
        async () => new Response("nope", { status }),
      );

      await expect(
        fetchJoinSuggestion("tok", "user@acme.com", {
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).resolves.toEqual({ match: false });
    }
  });

  it("returns no match when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      fetchJoinSuggestion("tok", "user@acme.com", {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({ match: false });
  });

  it("returns no match for malformed bodies", async () => {
    const fetchImpl = vi.fn(
      async () => jsonResponse({ match: true, company: { uid: "cmp_1" } }),
    );

    await expect(
      fetchJoinSuggestion("tok", "user@acme.com", {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({ match: false });
  });
});

describe("requestJoinCompany", () => {
  it("returns ok and sends the company uid on 2xx", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}", { status: 200 }),
    );

    await expect(
      requestJoinCompany("tok", "cmp_1", {
        fetchImpl: fetchImpl as typeof fetch,
        baseUrl: "https://example.test/",
      }),
    ).resolves.toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.test/membership/request-access");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ companyUid: "cmp_1" });
  });

  it("returns not ok on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 }));

    await expect(
      requestJoinCompany("tok", "cmp_1", {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("returns not ok when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      requestJoinCompany("tok", "cmp_1", {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});
