import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// US-007 — E2E walk of the streamlined 5-step flow.
//
// Screen flow under test:
//   1. Welcome  ("Set up HQ" + "Get Started")
//   2. Install  (silent ~/hq lay-down — auto-advances; "Preparing HQ")
//   3. Sign in  ("Continue with Google" — OAuth mocked here)
//   4. Setup    (unified post-login orchestrator — auto-advances; "Setting up HQ")
//   5. Done     ("HQ is ready")
//
// Removed-screen guard: the test asserts that the headings of every screen
// folded or deleted in US-005/006 never appear at ANY transition. This is the
// PRD's "github-walkthrough and template/packages never visible" assertion.
//
// Mocking strategy:
//   - Tauri IPC is stubbed via __TAURI_INTERNALS__ injected pre-React. The
//     mock keychain is stateful so the OAuth flow's 4-row token write is
//     visible to setup-progress's later getCurrentUser() read.
//   - Google OAuth is short-circuited at two seams:
//       (a) `oauth_listen_for_code` invoke resolves immediately with a fake
//           authorization code (no real loopback listener needed).
//       (b) the POST to /oauth2/token at the Cognito Hosted UI domain is
//           routed to a stub that returns mock tokens whose idToken decodes
//           to { sub, email, name } — enough for git-init + personalize.
//   - vault-handoff (`/entity/by-type/person`) returns no entities → the
//     setup orchestrator branches into Personal HQ mode and skips S3 sync.
// ---------------------------------------------------------------------------

// Headings of every screen deleted or folded by US-004/005/006 — must NEVER
// appear at any point in the walkthrough.
const REMOVED_SCREEN_HEADINGS = [
  'Set up GitHub',          // 05-github-walkthrough.tsx (deleted)
  'Choose template',        // 07-template.tsx (deleted)
  'Fetching template',
  'Install dependencies',   // 04-deps.tsx (folded into setup-progress)
  'Choose install directory', // old 06-directory picker (now silent)
  'Personalize your HQ',    // 09-personalize.tsx (folded)
  'Indexing HQ',            // 10-indexing.tsx (folded)
  'Git setup',              // 08-git-init.tsx (folded)
  'Create your account',    // old email/password Cognito copy (now Google-only)
];

async function expectRemovedScreensAbsent(page: Page): Promise<void> {
  for (const heading of REMOVED_SCREEN_HEADINGS) {
    // exact: false matches substrings — defends against the heading being
    // wrapped in some new container that adds incidental text around it.
    const count = await page.getByText(heading, { exact: false }).count();
    expect(count, `removed-screen text "${heading}" must not appear`).toBe(0);
  }
}

// ---------------------------------------------------------------------------
// Tauri mock init script (injected into browser before React loads)
// ---------------------------------------------------------------------------
// Pure JS (no Node modules) — runs in the page context. Simulates the Tauri 2
// IPC bridge and short-circuits every native call the 5-step flow makes.

const ID_TOKEN_PAYLOAD = {
  sub: 'e2e-user-123',
  email: 'e2e@example.com',
  name: 'E2E User',
  // given_name/family_name omitted on purpose — setup-progress's git-init
  // falls back to `name` when those are absent, exercising the realistic
  // Google-token shape (Google emits `name` not `family_name` for many users).
};
const ID_TOKEN_PAYLOAD_B64 = Buffer.from(JSON.stringify(ID_TOKEN_PAYLOAD))
  .toString('base64')
  .replace(/=+$/, '');
const MOCK_ID_TOKEN = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${ID_TOKEN_PAYLOAD_B64}.mock-signature`;

const TAURI_MOCK_SCRIPT = `
(function() {
  // Tell the install step (06-directory) to skip its network scaffold fetch:
  // this mocked browser env can't serve a real hq-core release tarball. The
  // wizard flow is what this walkthrough validates; the scaffold fetch itself
  // is covered by 06-directory.test.tsx and clean-room VM runs.
  window.__HQ_INSTALLER_E2E__ = true;
  const callbacks = new Map();
  const listeners = new Map(); // event -> [handlerId, ...]
  // Stateful keychain — cognito.ts stores 4 rows (access_token, id_token,
  // refresh_token, expires_at) and loadTokens() returns null if any are
  // missing, so the mock must actually persist what storeTokens writes.
  const keychainStore = new Map();

  function transformCallback(fn, once) {
    const id = Math.floor(Math.random() * 0xFFFFFFFF);
    callbacks.set(id, { fn, once });
    return id;
  }
  function runCallback(id, data) {
    const entry = callbacks.get(id);
    if (!entry) return;
    if (entry.once) callbacks.delete(id);
    entry.fn(data);
  }
  function unregisterCallback(id) {
    callbacks.delete(id);
  }
  function emitTauriEvent(event, payload) {
    const eventListeners = listeners.get(event) || [];
    for (const handlerId of eventListeners) {
      runCallback(handlerId, { event, id: 1, payload, windowLabel: 'main' });
    }
  }

  async function invoke(cmd, args) {
    // ── plugin:event — listen/emit/unlisten ─────────────────────────────
    if (cmd === 'plugin:event|listen') {
      const { event, handler } = args || {};
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return handler;
    }
    if (cmd === 'plugin:event|emit') {
      const { event, payload } = args || {};
      emitTauriEvent(event, payload);
      return null;
    }
    if (cmd === 'plugin:event|unlisten') {
      const { event, eventId } = args || {};
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(eventId);
        if (idx !== -1) arr.splice(idx, 1);
      }
      return null;
    }

    // ── plugin:app — installer-version probe ────────────────────────────
    if (cmd === 'plugin:app|version') {
      return '0.4.2-e2e';
    }

    // ── plugin:shell — Open authorize URL in system browser (no-op) ─────
    if (cmd === 'plugin:shell|open') {
      return null;
    }

    // ── Single-instance guard — this run is the primary instance ─────────
    if (cmd === 'is_primary_instance' || cmd === 'recheck_primary_instance') {
      return true;
    }

    // ── Install step (US-001) — silent ~/hq resolution ──────────────────
    if (cmd === 'resolve_hq_path') {
      return '/tmp/hq-e2e-test';
    }
    if (cmd === 'create_directory') {
      const parent = String((args && args.parent) || '').replace(/[\\\\/]+$/, '');
      const name = String((args && args.name) || '');
      const separator = parent.indexOf('\\\\') === -1 ? '/' : '\\\\';
      return {
        path: parent + separator + name,
        already_existed: false,
        non_empty: false,
      };
    }
    if (cmd === 'detect_hq') {
      return { exists: false, isHq: false };
    }
    if (cmd === 'check_writable') {
      return true;
    }

    // ── Sign-in step (US-003-ish) — OAuth loopback stub ─────────────────
    // The real command binds 127.0.0.1:53682 and blocks until the browser
    // hits /callback. Here we resolve immediately with a fixed code —
    // exchangeCodeForTokens is then routed (HTTP) to the token-endpoint
    // mock below.
    if (cmd === 'oauth_listen_for_code') {
      return { code: 'stub-auth-code' };
    }

    // ── Setup orchestrator: deps stage ──────────────────────────────────
    // runDepsInstall iterates DEPS and calls check_dep first; reporting
    // installed=true short-circuits the install_<dep> branch entirely.
    if (cmd === 'check_dep') {
      return { installed: true, version: '1.0.0' };
    }
    if (
      cmd === 'install_node' ||
      cmd === 'install_yq' ||
      cmd === 'install_qmd' ||
      cmd === 'install_hq_cli' ||
      cmd === 'install_git' ||
      cmd === 'install_gh' ||
      cmd === 'install_claude_code' ||
      cmd === 'install_homebrew'
    ) {
      return null;
    }

    // ── Setup orchestrator: git-init stage ──────────────────────────────
    if (cmd === 'git_init') {
      return 'abc1234abc1234abc1234abc1234abc1234abc1234';
    }

    // ── Setup orchestrator: indexing stage (spawn_process for qmd) ──────
    // The real command streams stdout/stderr/exit events; here we just
    // emit a successful exit so spawnAndWait resolves true.
    if (cmd === 'spawn_process') {
      const handle = 'proc-' + Math.random().toString(36).slice(2);
      setTimeout(function() {
        emitTauriEvent('process://' + handle + '/exit', {
          code: 0,
          success: true,
        });
      }, 50);
      return handle;
    }

    // ── Setup orchestrator: menubar stage ───────────────────────────────
    if (cmd === 'install_menubar_app') {
      return { success: true, appPath: '/Applications/HQ Sync.app', error: null };
    }
    if (cmd === 'launch_menubar_app') {
      return null;
    }

    // ── Summary screen probes / actions ─────────────────────────────────
    if (cmd === 'claude_desktop_installed') {
      return false;
    }
    if (cmd === 'open_claude_code_link') {
      return null;
    }
    if (cmd === 'launch_claude_code') {
      return null;
    }

    // ── Keychain — stateful (cognito.ts splits tokens across 4 rows) ───
    if (cmd === 'keychain_set') {
      const { service, account, secret } = args || {};
      keychainStore.set(service + ':' + account, secret);
      return null;
    }
    if (cmd === 'keychain_delete') {
      const { service, account } = args || {};
      keychainStore.delete(service + ':' + account);
      return null;
    }
    if (cmd === 'keychain_get') {
      const { service, account } = args || {};
      return keychainStore.get(service + ':' + account) || null;
    }

    // ── Cognito misc ────────────────────────────────────────────────────
    if (cmd === 'home_dir') {
      return '/tmp/hq-e2e-home';
    }

    // ── Tauri FS (used by manifest writer + personalize-writer) ─────────
    if (cmd === 'plugin:fs|mkdir') return null;
    if (cmd === 'plugin:fs|write_text_file' || cmd === 'plugin:fs|write_file') return null;
    if (cmd === 'plugin:fs|read_text_file' || cmd === 'plugin:fs|read_file') return '';
    if (cmd === 'plugin:fs|read_dir') return [];
    if (cmd === 'plugin:fs|exists') return false;
    if (cmd === 'plugin:path|resolve_path' || cmd === 'plugin:path|resolve_resource') {
      return '/mock-resource-path';
    }

    // ── Telemetry pref (best-effort, fire-and-forget) ──────────────────
    if (cmd === 'write_menubar_telemetry_pref') {
      return null;
    }

    // ── Failure ping (manifest-side, best-effort) ──────────────────────
    if (cmd === 'plugin:http|fetch') {
      return { status: 200, data: '{}', headers: {} };
    }

    // Default — log so a new invoke from future code shows up in test
    // output, but don't throw (best-effort branches swallow errors).
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[tauri-mock] Unhandled invoke:', cmd, args);
    }
    return null;
  }

  window.__TAURI_INTERNALS__ = {
    transformCallback,
    invoke,
    runCallback,
    unregisterCallback,
    callbacks,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: function(event, id) {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(id);
        if (idx !== -1) arr.splice(idx, 1);
      }
    },
  };
})();
`;

// ---------------------------------------------------------------------------
// HTTP route stubs
// ---------------------------------------------------------------------------

async function setupHttpStubs(page: Page): Promise<void> {
  // Cognito Hosted UI token exchange (PKCE step 4 in google-oauth.ts).
  // Domain matches playwright.config.ts VITE_COGNITO_DOMAIN default.
  await page.route('**/oauth2/token', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'mock-access-token',
        id_token: MOCK_ID_TOKEN,
        refresh_token: 'mock-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });
  });

  // vault-handoff /entity/by-type/person → no person entities means the
  // setup orchestrator's S3-sync stage skips into Personal-HQ mode without
  // trying to vend STS credentials.
  await page.route('**/entity/by-type/person', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entities: [] }),
    });
  });

  // Telemetry endpoint — silent acceptance so postOptIn / pingSuccess don't
  // hang the test on a real network call.
  await page.route('**/api/telemetry**', (route) => {
    route.fulfill({ status: 200, body: '{}' });
  });

  // Defensive: any other vault endpoints we might hit.
  await page.route('**/membership/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ memberships: [] }),
    });
  });
  await page.route('**/sts/vend', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        AccessKeyId: 'AKIA-MOCK',
        SecretAccessKey: 'mock',
        SessionToken: 'mock',
        Expiration: new Date(Date.now() + 3600_000).toISOString(),
      }),
    });
  });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.describe('Streamlined installer — 5-step walkthrough (US-007)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(TAURI_MOCK_SCRIPT);
    await setupHttpStubs(page);
  });

  test('welcome → install → Google sign-in → setup → done with no removed screens', async ({
    page,
  }) => {
    // ── Step 1: Welcome ────────────────────────────────────────────────────
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: /set up hq/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expectRemovedScreensAbsent(page);

    await page.getByRole('button', { name: /get started/i }).click();

    // ── Step 2: Install (silent ~/hq) ──────────────────────────────────────
    // The DirectoryPicker calls resolve_hq_path → setInstallPath →
    // onNext on success, so the heading is visible only briefly. We assert
    // it appears (or has already advanced past it) by waiting for either
    // "Preparing HQ" OR "Sign in" — both are valid mid-flight states.
    await expect
      .poll(
        async () => {
          const preparing = await page
            .getByText(/preparing hq/i, { exact: false })
            .count();
          const signedIn = await page
            .getByRole('heading', { name: /^sign in$/i })
            .count();
          return preparing + signedIn;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    await expectRemovedScreensAbsent(page);

    // ── Step 3: Sign in (Google OAuth — stubbed) ───────────────────────────
    await expect(
      page.getByRole('heading', { name: /^sign in$/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expectRemovedScreensAbsent(page);

    // The Sign in screen renders a single "Continue with Google" button.
    // Clicking it kicks off the (mocked) OAuth flow:
    //   oauth_listen_for_code → {code: stub}
    //   exchangeCodeForTokens → mock tokens (idToken decodes to E2E user)
    //   storeTokens → 4 keychain rows persisted in-memory
    //   onNext → step 4 (Setup)
    await page.getByRole('button', { name: /continue with google/i }).click();

    // ── Step 4: Setup (unified orchestrator) ───────────────────────────────
    // The orchestrator runs 5 stages behind one progress bar. We just check
    // that the heading appears and then auto-advances to Done — exactly the
    // PRD contract ("no intermediate input").
    await expect(
      page.getByRole('heading', { name: /setting up hq/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expectRemovedScreensAbsent(page);

    // ── Step 5: Done ───────────────────────────────────────────────────────
    // Generous timeout — the orchestrator chains six async stages that each
    // tick through journal writes + state patches before resolving.
    await expect(
      page.getByRole('heading', { name: /hq is ready/i }),
    ).toBeVisible({ timeout: 60_000 });
    await expectRemovedScreensAbsent(page);

    // Sanity: the install path written by step 2 surfaces on the summary.
    // The path renders twice (summary card + "Open in Claude Desktop"
    // instructions panel) — .first() picks one for the visibility assert.
    await expect(page.getByText('/tmp/hq-e2e-test').first()).toBeVisible();
  });
});
