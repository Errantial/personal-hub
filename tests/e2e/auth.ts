import type { Page, BrowserContext } from '@playwright/test';
import { expect } from '@playwright/test';
const credentials = {
  email: 'browser@example.test',
  password: 'synthetic-browser-password',
};
let cookies: Parameters<BrowserContext['addCookies']>[0] = [];
export async function authenticate(page: Page) {
  if (cookies.length) await page.context().addCookies(cookies);
  const status = await page.request.get('/api/v1/auth/session');
  const session = (await status.json()) as {
    user: unknown;
    setupRequired: boolean;
  };
  if (!session.user) {
    const response = await page.request.post(
      `/api/v1/auth/${session.setupRequired ? 'setup' : 'login'}`,
      { data: credentials, headers: { Origin: 'http://127.0.0.1:5180' } },
    );
    expect(response.status()).toBe(session.setupRequired ? 201 : 200);
    cookies = (await page.request.storageState()).cookies;
  }
}
