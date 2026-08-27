/**
 * AI provider health.
 *
 * The production symptom that prompted this — "ai provider  built-in template
 * engine (no OPENAI_API_KEY)" — turned out to be the *benign* case: no key is
 * set, and the documented template path runs. The dangerous case is the one
 * that looked identical from outside: a key that is set but expired, revoked,
 * out of quota, or naming a model the account cannot reach. Generation still
 * succeeds, output still arrives, and it is all produced by templates.
 *
 * These tests pin the distinction. They deliberately do not call OpenAI: what
 * is under test is the bookkeeping that makes a silent fallback visible, not
 * the provider itself.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  aiHealth, deriveState, recordProviderFailure, recordProviderSuccess, resetProviderHealth,
} from '../src/services/ai/health.js';
import { aiStatus } from '../src/services/ai/index.js';

// The suite runs with OPENAI_API_KEY empty (see vitest.config.ts), so
// `keyConfigured` is false throughout and NOT_CONFIGURED dominates the state.
// That is exactly production's configuration, which makes it the right default
// to assert against.
describe('ai provider health', () => {
  beforeEach(() => resetProviderHealth());

  it('reports NOT_CONFIGURED when no key is set, and says it is a supported mode', () => {
    const health = aiHealth();

    expect(health.keyConfigured).toBe(false);
    expect(health.state).toBe('NOT_CONFIGURED');
    // The distinction the whole module exists for: absent key is not a fault.
    expect(health.degraded).toBe(false);
    expect(health.detail).toContain('OPENAI_API_KEY');
    expect(health.detail).toContain('supported mode');
  });

  it('does not claim degradation merely because no model is configured', () => {
    recordProviderFailure('generateCopy', new Error('irrelevant'));
    // Without a key there is no provider to be degraded *from*.
    expect(aiHealth().state).toBe('NOT_CONFIGURED');
    expect(aiHealth().degraded).toBe(false);
  });

  it('counts what this process actually observed', () => {
    recordProviderSuccess();
    recordProviderSuccess();
    recordProviderFailure('generateHashtags', new Error('429 rate limited'));

    const health = aiHealth();
    expect(health.callsThisProcess).toEqual({ succeeded: 2, failed: 1 });
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastFailureOperation).toBe('generateHashtags');
    expect(health.lastFailureMessage).toBe('429 rate limited');
    expect(health.lastSuccessAt).not.toBeNull();
  });

  it('clears the consecutive-failure run on the next success', () => {
    recordProviderFailure('analyzeCampaigns', new Error('500'));
    recordProviderFailure('analyzeCampaigns', new Error('500'));
    expect(aiHealth().consecutiveFailures).toBe(2);

    recordProviderSuccess();
    expect(aiHealth().consecutiveFailures).toBe(0);
    // The failure itself is still on the record — a recovered provider is not
    // a provider that never failed, and the total is what shows a flapping key.
    expect(aiHealth().callsThisProcess.failed).toBe(2);
  });

  it('never puts an API key into a message an operator or the UI can read', () => {
    recordProviderFailure(
      'generateCopy',
      new Error('Incorrect API key provided: sk-proj-abcdef0123456789ZZ. Check your key.'),
    );

    const message = aiHealth().lastFailureMessage ?? '';
    expect(message).not.toContain('sk-proj-abcdef0123456789ZZ');
    expect(message).toContain('sk-***');
  });

  /*
   * The four states, exercised directly.
   *
   * DEGRADED and HEALTHY require a configured key, which the test environment
   * deliberately does not have — so the state machine is tested as the pure
   * function it is, rather than by smuggling a key into the suite.
   */
  it('separates a missing key from a broken one', () => {
    expect(deriveState({ configured: false, consecutiveFailures: 0, hasSucceeded: false }))
      .toBe('NOT_CONFIGURED');

    // A key nobody has exercised yet is not a working key.
    expect(deriveState({ configured: true, consecutiveFailures: 0, hasSucceeded: false }))
      .toBe('UNVERIFIED');

    expect(deriveState({ configured: true, consecutiveFailures: 0, hasSucceeded: true }))
      .toBe('HEALTHY');

    // The case the audit was about: configured, paid for, and silently unused.
    expect(deriveState({ configured: true, consecutiveFailures: 1, hasSucceeded: true }))
      .toBe('DEGRADED');
  });

  it('exposes health through aiStatus without breaking its existing shape', () => {
    const status = aiStatus();

    // Pre-existing fields every current caller reads.
    expect(status).toHaveProperty('provider');
    expect(status).toHaveProperty('model');
    expect(status).toHaveProperty('configured');

    // With no key configured, generations really are served by templates and
    // `effectiveProvider` must say so rather than echoing the intent.
    expect(status.configured).toBe(false);
    expect(status.effectiveProvider).toBe('template');
    expect(status.health.state).toBe('NOT_CONFIGURED');
  });
});
