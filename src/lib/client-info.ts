/**
 * Outbound-request headers identifying this app to hq-cloud-api + GitHub.
 *
 * `__APP_NAME__` and `__APP_VERSION__` are Vite `define` globals — replaced
 * at build time with the values from `package.json`. The same `__APP_VERSION__`
 * convention is already used by Sentry release tagging in `vite.config.ts`.
 *
 * Mirrors the shape of `@indigoai-us/hq-cloud`'s `buildClientHeaders` so
 * server-side traffic attribution is consistent across all HQ clients. We
 * inline the helper here rather than depending on the package to avoid
 * pulling its AWS SDK transitive deps into the Tauri renderer bundle.
 */

declare const __APP_NAME__: string;
declare const __APP_VERSION__: string;

export const CLIENT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent": `${__APP_NAME__}/${__APP_VERSION__}`,
  "x-hq-client-name": __APP_NAME__,
  "x-hq-client-version": __APP_VERSION__,
});
