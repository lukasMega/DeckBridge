import { click, pressEscape } from '../../helpers/click.js';
import { gotoApp } from '../../helpers/goto.js';
import { test, expect, api, getSettings } from '../../fixtures/app.js';

test('feedback stepper submits locally but mock never sends', async ({ page, request, app }) => {
  const before = await getSettings(request, app.baseURL);
  await gotoApp(page, `${app.baseURL}/`);
  await click(page.locator('#settingsBtn'));
  await click(page.getByRole('button', { name: 'Give feedback', exact: true }));
  const modal = page.locator('#survey-modal');
  await expect(modal).toHaveCount(1);
  await click(modal.getByRole('radio', { name: 'Good', exact: true }));
  await expect(modal.locator('.survey-q')).toHaveText('Did it do what you expected?');
  for (let i = 0; i < 3; i++) await click(modal.getByRole('button', { name: 'Skip', exact: true }));
  await click(modal.getByRole('checkbox', { name: 'Other', exact: true }));
  await expect(modal.getByRole('textbox', { name: 'Other use', exact: true })).toBeFocused();
  await expect(modal.getByRole('button', { name: 'Next ›', exact: true })).toBeDisabled();
  await modal.getByRole('textbox', { name: 'Other use', exact: true }).fill('x'.repeat(300));
  await click(modal.getByRole('button', { name: 'Next ›', exact: true }));
  for (let i = 0; i < 2; i++) await click(modal.getByRole('button', { name: 'Skip', exact: true }));
  await click(modal.getByRole('checkbox', { name: 'Other', exact: true }));
  const next = modal.getByRole('button', { name: 'Next ›', exact: true });
  await expect(modal.getByRole('textbox', { name: 'Other request', exact: true })).toBeFocused();
  await expect(next).toBeDisabled();
  await modal.getByRole('textbox', { name: 'Other request', exact: true }).fill('   ');
  await expect(next).toBeDisabled();
  await click(modal.getByRole('button', { name: 'Skip', exact: true }));
  await click(modal.getByRole('button', { name: 'Back', exact: true }));
  await expect(modal.getByRole('textbox', { name: 'Other request', exact: true })).toHaveCount(0);
  await expect(next).toBeEnabled();
  await click(modal.getByRole('checkbox', { name: 'Other', exact: true }));
  await modal.getByRole('textbox', { name: 'Other request', exact: true }).fill('y'.repeat(100));
  await click(modal.getByRole('button', { name: 'Next ›', exact: true }));
  for (let i = 0; i < 3; i++) await click(modal.getByRole('button', { name: 'Skip', exact: true }));
  await expect(modal.locator('.survey-q')).toHaveText('Review your feedback');
  const preview = JSON.parse((await modal.locator('#survey-preview').textContent()) ?? '{}');
  expect(preview.a).toEqual({ rating: '4', 'use-for': ['other'], want: ['other'] });
  expect(preview.useForOther).toBe('x'.repeat(300));
  expect(preview.wantOther).toBe('y'.repeat(100));
  const reply = page.waitForResponse(
    (r) => r.url().endsWith('/api/survey') && r.request().method() === 'POST',
  );
  await click(modal.getByRole('button', { name: 'Send', exact: true }));
  const response = await reply;
  expect(response.request().postDataJSON()).toEqual(preview);
  expect(await response.json()).toEqual({ sent: false, reason: 'mock' });
  await expect(modal.getByRole('status')).toContainText('mock mode never sends');
  await pressEscape(page, async () => (await modal.count()) === 0);
  await expect(page.locator('.settings-page')).toHaveCount(1);
  const short = page.locator('#survey-short');
  await expect(short).toHaveCount(1);
  await click(short.getByRole('button', { name: 'No thanks', exact: true }));
  await expect(short).toHaveCount(0);
  await click(page.locator('#footerFeedback'));
  await expect(modal.locator('#survey-preview')).toContainText('"rating": "4"');
  await click(modal.getByRole('button', { name: "Don't send", exact: true }));
  await click(page.locator('#aboutBtn'));
  await click(page.getByRole('dialog').getByRole('button', { name: 'Give feedback', exact: true }));
  await expect(modal.locator('#survey-preview')).toContainText('"rating": "4"');
  const after = (await getSettings(request, app.baseURL)).survey;
  expect(before.survey?.snoozedUntil ?? after?.snoozedUntil).toBeTruthy();
  expect(after?.never).toBeUndefined();
  expect(after?.submittedSv).toBeUndefined();
  expect((await api(request, app.baseURL, '/api/survey')).json).toHaveProperty('state', after);
});

test("Don't send offers the 3-question form; mock never sends it", async ({ page, app }) => {
  await gotoApp(page, `${app.baseURL}/`);
  await expect(page.locator('#surveyNudge')).toHaveCount(0);
  await click(page.locator('#footerFeedback'));
  const modal = page.locator('#survey-modal');
  await click(modal.getByRole('radio', { name: 'Good', exact: true }));
  const title = modal.locator('.survey-q');
  for (let i = 0; i < 20 && (await title.textContent()) !== 'Review your feedback'; i++)
    await click(modal.getByRole('button', { name: 'Next ›', exact: true }));
  await click(modal.getByRole('button', { name: "Don't send", exact: true }));
  const short = page.locator('#survey-short');
  await expect(short).toHaveCount(1);
  const send = short.getByRole('button', { name: 'Send 3 answers', exact: true });
  await expect(short.getByRole('radio', { name: 'Good', exact: true })).toBeChecked();
  await expect(send).toBeDisabled();
  await expect(short.getByRole('checkbox', { name: 'Other', exact: true })).toHaveCount(0);
  await click(short.getByRole('radio', { name: '9', exact: true }));
  await click(short.getByRole('checkbox', { name: 'Graphs / gauges', exact: true }));
  await expect(send).toBeEnabled();
  const reply = page.waitForResponse(
    (r) => r.url().endsWith('/api/survey') && r.request().method() === 'POST',
  );
  await click(send);
  const sent = (await reply).request().postDataJSON();
  expect(sent.f).toBe('short');
  expect(Object.keys(sent.a).sort()).toEqual(['nps', 'rating', 'want']);
  await expect(short.getByRole('status')).toHaveText('Not sent: mock mode never sends feedback.');
});
