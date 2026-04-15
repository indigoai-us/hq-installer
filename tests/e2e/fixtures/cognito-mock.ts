import type { Page } from '@playwright/test';

// Mock JWT - valid base64url-encoded payload: { sub: 'user-123', email: 'test@example.com' }
const MOCK_ID_TOKEN =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJzdWIiOiJ1c2VyLTEyMyIsImVtYWlsIjoidGVzdEBleGFtcGxlLmNvbSJ9.' +
  'mock-signature';

const MOCK_TOKENS = {
  AuthenticationResult: {
    AccessToken: 'mock-access-token',
    IdToken: MOCK_ID_TOKEN,
    RefreshToken: 'mock-refresh-token',
    ExpiresIn: 3600,
    TokenType: 'Bearer',
  },
  ChallengeParameters: {},
};

export async function setupCognitoMock(page: Page): Promise<void> {
  // Intercept all Cognito API calls (any region)
  // Use a regex to match any region subdomain
  await page.route(/https:\/\/cognito-idp\..+\.amazonaws\.com.*/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/x-amz-json-1.1',
      body: JSON.stringify(MOCK_TOKENS),
    });
  });
}
