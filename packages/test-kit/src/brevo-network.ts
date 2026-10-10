// Workers-only provider HTTP fixture. D1, KV, R2 and Queue remain real bindings.
import { setupNetwork } from '@msw/cloudflare';
import { http, HttpResponse } from 'msw';

export const BREVO_TEST_CONFIG = {
  apiKey: 'synthetic-brevo-key-for-tests',
  domain: 'example.com',
  recipientEmail: 'admin@example.com',
} as const;

export function createBrevoNetwork() {
  const network = setupNetwork();
  const sent: Record<string, unknown>[] = [];
  const handlers = [
    http.get('https://api.brevo.com/v3/account', ({ request }) =>
      request.headers.get('api-key') === BREVO_TEST_CONFIG.apiKey
        ? HttpResponse.json({ email: BREVO_TEST_CONFIG.recipientEmail })
        : HttpResponse.json({ code: 'unauthorized' }, { status: 401 }),
    ),
    http.post('https://api.brevo.com/v3/smtp/email', async ({ request }) => {
      if (request.headers.get('api-key') !== BREVO_TEST_CONFIG.apiKey)
        return HttpResponse.json({ code: 'unauthorized' }, { status: 401 });
      sent.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ messageId: '<synthetic-message@example.com>' }, { status: 201 });
    }),
    // Unexpected external requests fail locally, never reach a real provider.
    http.all('*', () => HttpResponse.error()),
  ];
  return {
    network,
    sent,
    reset() {
      sent.length = 0;
      network.resetHandlers();
      network.use(...handlers);
    },
  };
}
