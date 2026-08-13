// apps/worker/src/integrations/providers/provider-registry.ts — CAP-014.
// Provider registry maps ProviderKey to OutboundProviderAdapter.
//
// ADR-002: Modules call adapters through the OutboundProviderAdapter
// interface — never the SDK directly. This registry is the single place
// to look up an adapter by key.
//
// Phase 1: Only Brevo. Phase 5 adds Resend and CF-Sendmail.

import type { OutboundProviderAdapter, ProviderKey } from '@unimailbox/contracts';
import { brevoAdapter } from './brevo';

/**
 * ProviderRegistry — maps provider keys to their adapter implementations.
 *
 * The registry is a simple Map for now. Future phases may add plugin
 * discovery or dynamic registration, but the core pattern remains: use cases
 * call through the interface, not the SDK.
 */
class ProviderRegistry {
  private readonly adapters = new Map<ProviderKey, OutboundProviderAdapter>();

  constructor() {
    // Register Brevo for CAP-014
    this.register(brevoAdapter);
    // Resend and CF-Sendmail will be registered in Phase 5
  }

  /**
   * Register an adapter.
   *
   * @param adapter — The adapter implementing OutboundProviderAdapter
   */
  register(adapter: OutboundProviderAdapter): void {
    this.adapters.set(adapter.key, adapter);
  }

  /**
   * Get an adapter by provider key.
   *
   * @param key — The provider key (e.g. parseProviderKey('brevo'))
   * @returns The adapter, or undefined if not registered
   */
  get(key: ProviderKey): OutboundProviderAdapter | undefined {
    return this.adapters.get(key);
  }

  /**
   * Check if an adapter is registered.
   *
   * @param key — The provider key
   * @returns true if registered, false otherwise
   */
  has(key: ProviderKey): boolean {
    return this.adapters.has(key);
  }

  /**
   * List all registered provider keys.
   *
   * @returns An array of registered provider keys
   */
  list(): ProviderKey[] {
    return Array.from(this.adapters.keys());
  }
}

// Singleton instance — the entire Worker shares one registry
export const providerRegistry = new ProviderRegistry();
