import type { Page } from '@playwright/test';

export async function setupGithubReleasesMock(page: Page): Promise<void> {
  // Intercept GitHub releases API
  await page.route('https://api.github.com/repos/**/releases/latest', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tag_name: 'v0.1.0',
        assets: [{
          name: 'hq-template.tar.gz',
          browser_download_url: 'https://github.com/mock/releases/download/v0.1.0/hq-template.tar.gz',
        }],
      }),
    });
  });

  // Intercept GitHub archive downloads
  await page.route('https://github.com/**/*.tar.gz', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from('mock-tarball'),
    });
  });
}
