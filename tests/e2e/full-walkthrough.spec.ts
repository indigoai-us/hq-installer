import { test, expect } from '@playwright/test';
import { setupCognitoMock } from './fixtures/cognito-mock';
import { setupGithubReleasesMock } from './fixtures/github-releases-mock';

// ---------------------------------------------------------------------------
// Tauri mock init script (injected into browser before React loads)
// ---------------------------------------------------------------------------
// This script is pure JS — it cannot import Node modules.
// It simulates the Tauri 2 IPC bridge so components work in a plain browser.
const TAURI_MOCK_SCRIPT = `
(function() {
  const callbacks = new Map();
  const listeners = new Map(); // event -> [handlerId, ...]
  // Stateful keychain store — keyed by "\${service}:\${account}". Required by
  // cognito.ts loadTokens(), which reads access_token / id_token / refresh_token /
  // expires_at separately. A no-op keychain broke screen 03's getCurrentUser()
  // because handleCreate throws "No active session" when any token is missing.
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
    // plugin:event — listen/emit/unlisten
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

    // Dependency checking
    if (cmd === 'check_dep') {
      return { installed: true, version: '1.0.0' };
    }
    if (cmd === 'xcode_clt_status') {
      return { installed: true };
    }
    if (cmd === 'check_xcode_clt') {
      return { installed: true };
    }

    // Directory picking
    if (cmd === 'pick_directory') {
      return '/tmp/hq-e2e-test';
    }
    if (cmd === 'detect_hq') {
      return { exists: false, isHq: false };
    }

    // Template fetch — schedules template:progress event with done=true
    if (cmd === 'fetch_template') {
      setTimeout(function() {
        emitTauriEvent('template:progress', {
          downloaded: 1024,
          total: 1024,
          done: true,
        });
      }, 100);
      return null;
    }

    // Git user probe
    if (cmd === 'git_probe_user') {
      return { name: 'E2E User', email: 'e2e@example.com' };
    }

    // Git init
    if (cmd === 'git_init') {
      return 'abc1234abc1234abc1234abc1234abc1234abc1234';
    }

    // Process spawning — used by git-init steps 1+2 and indexing
    if (cmd === 'spawn_process') {
      const handle = 'proc-' + Math.random().toString(36).slice(2);
      setTimeout(function() {
        emitTauriEvent('process://' + handle + '/exit', {
          code: 0,
          success: true,
        });
      }, 100);
      return handle;
    }

    // qmd indexing
    if (cmd === 'run_qmd') {
      return null;
    }

    // Keychain — stateful per-service/account store. cognito.ts splits tokens
    // across 4 rows (access_token, id_token, refresh_token, expires_at) and
    // loadTokens() returns null if ANY row is missing — so we have to actually
    // persist what sign-in writes.
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

    // Claude Code launch
    if (cmd === 'launch_claude_code') {
      return null;
    }

    // Webview
    if (cmd === 'open_webview') {
      return null;
    }

    // Homebrew / xcode install commands (should not be called since all deps are installed)
    if (cmd === 'install_homebrew' || cmd === 'xcode_clt_install' || cmd === 'install_node' ||
        cmd === 'install_git' || cmd === 'install_gh' || cmd === 'install_claude_code' || cmd === 'install_qmd') {
      return null;
    }

    // Telemetry ping (fire-and-forget)
    if (cmd === 'plugin:http|fetch') {
      return { status: 200, data: '{}', headers: {} };
    }

    // Tauri FS operations used by personalize-writer
    if (cmd === 'plugin:fs|mkdir') {
      return null;
    }
    if (cmd === 'plugin:fs|write_text_file' || cmd === 'plugin:fs|write_file') {
      return null;
    }
    if (cmd === 'plugin:path|resolve_path' || cmd === 'plugin:path|resolve_resource') {
      // Return a mock path that readDir can "read"
      return '/mock-resource-path';
    }
    if (cmd === 'plugin:fs|read_dir') {
      // Return empty array — no starter project files to iterate
      return [];
    }
    if (cmd === 'plugin:fs|read_text_file' || cmd === 'plugin:fs|read_file') {
      return '';
    }
    if (cmd === 'plugin:fs|exists') {
      return false;
    }

    console.warn('[tauri-mock] Unhandled invoke:', cmd, args);
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
// Test
// ---------------------------------------------------------------------------

test.describe('HQ Installer walkthrough', () => {
  test.beforeEach(async ({ page }) => {
    // Inject Tauri mock before React loads
    await page.addInitScript(TAURI_MOCK_SCRIPT);

    // Set up HTTP mocks
    await setupCognitoMock(page);
    await setupGithubReleasesMock(page);

    // Mock the team registration API — snake_case contract matches hq-ops
    // /api/installer/register-company which returns { team_id, company_id, created_at }.
    // 03-team.tsx reassembles TeamMetadata from response IDs + local form state.
    await page.route('**/api/installer/register-company', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          team_id: 'team-e2e-123',
          company_id: 'company-e2e-123',
          created_at: new Date().toISOString(),
        }),
      });
    });

    // Mock telemetry endpoint
    await page.route('**/api/telemetry**', (route) => {
      route.fulfill({ status: 200, body: '{}' });
    });
  });

  test('full 11-screen walkthrough', async ({ page }) => {
    // ── Screen 1: Welcome ──────────────────────────────────────────────────
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /set up hq/i })).toBeVisible();
    await page.getByRole('button', { name: /get started/i }).click();

    // ── Screen 2: CognitoAuth — sign in ────────────────────────────────────
    await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();
    await page.getByLabel('Email').fill('test@example.com');
    await page.getByLabel('Password').fill('TestPassword123!');
    await page.getByRole('button', { name: /^sign in$/i }).click();

    // ── Screen 3: TeamSetup — create team ──────────────────────────────────
    // Heading is "Create your team" after the Join-team mode was removed in the
    // hq-ops register-company contract cut-over.
    await expect(page.getByRole('heading', { name: /create your team/i })).toBeVisible();
    await page.getByLabel('Team name').fill('E2E Test Team');
    // Slug auto-fills from the team name — clear + retype to override so the
    // explicit value lands in the POST body instead of "e2e-test-team".
    await page.getByLabel('Slug').clear();
    await page.getByLabel('Slug').fill('e2e-test');
    await page.getByRole('button', { name: /^create team$/i }).click();

    // ── Screen 4: DepsInstall — deps auto-detected as installed ────────────
    await expect(page.getByText(/homebrew/i)).toBeVisible();
    // Wait for all deps to show installed and Continue button to appear
    await expect(page.getByRole('button', { name: /continue/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /continue/i }).click();

    // ── Screen 5: GithubWalkthrough ─────────────────────────────────────────
    await expect(page.getByRole('heading', { name: /set up github/i })).toBeVisible();
    await page.locator('[data-step="account"]').check();
    await page.locator('[data-step="ssh"]').check();
    await page.locator('[data-step="pat"]').check();
    await page.locator('#pat-input').fill('ghp_mocktokenvalue');
    // Trigger keychain_set on blur
    await page.locator('#pat-input').blur();
    await expect(page.getByRole('button', { name: /continue/i })).toBeVisible();
    await page.getByRole('button', { name: /continue/i }).click();

    // ── Screen 6: DirectoryPicker ───────────────────────────────────────────
    await expect(page.getByRole('heading', { name: /choose install directory/i })).toBeVisible();
    await page.getByRole('button', { name: /choose folder/i }).click();
    // After mocked pick_directory and detect_hq, path shows and Continue appears
    await expect(page.getByText('/tmp/hq-e2e-test')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /continue/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /continue/i }).click();

    // ── Screen 7: TemplateFetch — auto-starts, waits for done ──────────────
    await expect(page.getByRole('heading', { name: /fetching template/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /continue/i })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /continue/i }).click();

    // ── Screen 8: GitInit — git user pre-filled, run setup ─────────────────
    await expect(page.getByRole('heading', { name: /git setup/i })).toBeVisible();
    // git_probe_user is mocked to return name + email so fields pre-fill
    await expect(page.getByLabel('Name')).toHaveValue('E2E User', { timeout: 5_000 });
    await page.getByRole('button', { name: /run setup/i }).click();
    await expect(page.getByRole('button', { name: /continue/i })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /continue/i }).click();

    // ── Screen 9: Personalize — 3-step form ────────────────────────────────
    await expect(page.getByRole('heading', { name: /personaliz/i })).toBeVisible();

    // Step 1: Identity
    await page.getByLabel('Name').fill('E2E Test User');
    await page.getByLabel('About').fill('A developer testing the installer');
    await page.getByLabel('Goals').fill('Ship more with AI assistance');
    // The WizardShell also has a "Next" button — use .first() to click the form's Next
    await page.getByRole('button', { name: /^next$/i }).first().click();

    // Step 2: Starter project
    await page.getByLabel('Code Worker').check();
    await page.getByRole('button', { name: /^next$/i }).first().click();

    // Step 3: Customization + submit
    // personalize() calls Tauri FS — mocked via invoke handlers
    await page.getByRole('button', { name: /^submit$/i }).click();

    // ── Screen 10: Indexing — auto-starts, waits for done ──────────────────
    await expect(page.getByRole('heading', { name: /indexing hq/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /continue/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /continue/i }).click();

    // ── Screen 11: Summary ──────────────────────────────────────────────────
    await expect(page.getByRole('heading', { name: /hq is ready/i })).toBeVisible();
    await expect(page.getByText('/tmp/hq-e2e-test')).toBeVisible();
  });
});
