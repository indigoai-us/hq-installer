// tauri-http-handler.ts
// Custom Smithy HttpHandler that routes AWS SDK calls through Tauri's
// `plugin-http` fetch instead of WebKit's native fetch.
//
// Why this exists:
//   WebKit's native fetch (the default used by @aws-sdk/client-s3's
//   FetchHttpHandler) is subject to browser CORS rules. S3 buckets do not
//   send CORS headers for Tauri's webview origin, which manifests as
//   "Load failed" with no further detail. Tauri's plugin-http runs the
//   request in the Rust process, bypassing CORS entirely.
//
// Implementation:
//   We conform to the Smithy HttpHandler interface (`handle(request, opts)`
//   returning `{ response: HttpResponse }`) but translate the request to a
//   Tauri `fetch` call. The body is read as a Blob so the SDK's
//   `transformToByteArray()` / `transformToString()` helpers work unchanged.

import { HttpResponse } from "@smithy/protocol-http";
import type { HttpHandler, HttpRequest } from "@smithy/protocol-http";
import type { HttpHandlerOptions } from "@smithy/types";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export class TauriHttpHandler implements HttpHandler {
  destroy(): void {
    // No-op — Tauri's fetch has no long-lived connection pool on the JS side.
  }

  metadata = { handlerProtocol: "http/1.1" };

  async handle(
    request: HttpRequest,
    { abortSignal }: HttpHandlerOptions = {},
  ): Promise<{ response: HttpResponse }> {
    // ---- Build URL ------------------------------------------------------
    const queryString = Object.entries(request.query ?? {})
      .flatMap(([key, val]) => {
        if (val === null || val === undefined) return [];
        const values = Array.isArray(val) ? val : [val];
        return values.map(
          (v) => `${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`,
        );
      })
      .join("&");

    const path =
      request.path +
      (queryString ? `?${queryString}` : "") +
      (request.fragment ? `#${request.fragment}` : "");

    const port = request.port ? `:${request.port}` : "";
    const url = `${request.protocol}//${request.hostname}${port}${path}`;

    // ---- Body -----------------------------------------------------------
    // Omit body for GET/HEAD — fetch spec forbids a body on those methods.
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : (request.body as BodyInit | undefined);

    // ---- Make the request through Tauri --------------------------------
    const response = await tauriFetch(url, {
      method: request.method,
      headers: request.headers,
      body,
      signal: abortSignal as AbortSignal | undefined,
    });

    // ---- Collect headers ------------------------------------------------
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // ---- Collect body as Blob ------------------------------------------
    // The SDK's sdkStreamMixin can transformToByteArray / transformToString
    // on a Blob, so this covers both the XML list response and the binary
    // GetObject response.
    const responseBody = await response.blob();

    return {
      response: new HttpResponse({
        statusCode: response.status,
        reason: response.statusText,
        headers: responseHeaders,
        body: responseBody,
      }),
    };
  }

  updateHttpClientConfig(): void {
    // No-op — the SDK calls this with caching/keepalive hints that don't
    // apply to our plugin-http bridge.
  }

  httpHandlerConfigs(): Record<string, unknown> {
    return {};
  }
}
