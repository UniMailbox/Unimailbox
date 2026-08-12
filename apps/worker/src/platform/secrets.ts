// platform/secrets — secret reading helper.
//
// SecretsStoreSecret.get() in production; plain string in tests (miniflare override).
// This helper handles both without the use case knowing about Cloudflare types.

/**
 * Union type for things that behave like secrets. In production, the binding
 * is a SecretsStoreSecret with a get() method. In miniflare tests, the override
 * provides a plain string.
 */
type SecretLike = string | { get(): Promise<string> };

/**
 * Read a secret value, handling both SecretsStoreSecret (production) and
 * plain string (test/miniflare override) forms.
 */
export async function readSecret(secret: SecretLike): Promise<string> {
  return typeof secret === 'string' ? secret : secret.get();
}
