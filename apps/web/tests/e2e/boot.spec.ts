import { expect, test } from '@playwright/test';

test('boots to the login page when no session exists', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to Mata' })).toBeVisible();
  await expect(page.getByLabel('Homeserver')).toHaveValue(/matrix\.org/);
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('shows a validation error when login fields are empty', async ({ page }) => {
  await page.goto('/login');
  const submit = page.getByRole('button', { name: 'Sign in' });
  await submit.click();
  // Browser-native validation prevents submit; the username input becomes invalid.
  const username = page.getByLabel('Username');
  await expect(username).toHaveAttribute('required', '');
  await expect(username).toHaveJSProperty('validationMessage', /\S+/);
});
