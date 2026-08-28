/**
 * Whether the configured AI provider is actually working.
 *
 * The audit that produced this module found the P0 to be a *configuration*
 * fact, not a code defect: production has no `OPENAI_API_KEY`, so `hasOpenAi`
 * is false and every generator takes its documented template path. The code is
 * behaving exactly as designed.
 *
 * What the code did *not* have was any way to tell that state apart from a
 * worse one. `aiStatus()` reported `provider: 'openai', configured: true` from
 * the mere presence of a key string, while a key that is expired, revoked, out
 * of quota or pointed at a model the account cannot access makes every
 * generation fail into the template engine behind a single `console.warn`. To
 * an operator reading the admin screen, a silently degraded deployment and a
 * healthy one looked identical — and the degraded one is the dangerous one,
 * because somebody is paying for a model that is never called.
 *
 * So this module records what actually happened on the last provider call and
 * offers a live probe. Four states, deliberately distinct:
 *
 *   NOT_CONFIGURED  no key — the template engine by design (production today)
 *   UNVERIFIED      key set, no call attempted yet this process
 *   HEALTHY         key set, the last call succeeded
 *   DEGRADED        key set, calls are failing — serving templates silently
 *
 * State is per-process and in memory on purpose. It describes *this* process's
 * experience of the provider, it must survive nothing, and persisting it would
 * mean a schema change and a write on a hot path to store something that is
 * stale the moment the process restarts. `AiUsage` already keeps the durable
 * per-call record.
 */

import OpenAI from 'openai';
import { env, hasOpenAi } from '../../env.js';

export type AiProviderState = 'NOT_CONFIGURED' | 'UNVERIFIED' | 'HEALTHY' | 'DEGRADED';

/** Redacts anything key-shaped before a provider message is shown to anyone. */
function redact(message: string): string {
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

interface ProviderMemory {
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureMessage: string | null;
  lastFailureOperation: string | null;
  consecutiveFailures: number;
  successes: number;
  failures: number;
}

const memory: ProviderMemory = {
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureMessage: null,
  lastFailureOperation: null,
  consecutiveFailures: 0,
  successes: 0,
  failures: 0,
};

/** A provider call returned something the schemas accepted. */
export function recordProviderSuccess(): void {
  memory.lastSuccessAt = new Date();
  memory.consecutiveFailures = 0;
  memory.successes += 1;
}

/**
 * A provider call failed and the caller fell back to the template engine.
 *
 * Called from the facade's catch blocks, which is the only place that knows a
 * fallback actually happened rather than a key merely being absent.
 */
export function recordProviderFailure(operation: string, error: unknown): void {
  memory.lastFailureAt = new Date();
  memory.lastFailureOperation = operation;
  memory.lastFailureMessage = redact((error as Error)?.message ?? String(error));
  memory.consecutiveFailures += 1;
  memory.failures += 1;
}

/** Test seam — resets the per-process memory. */
export function resetProviderHealth(): void {
  memory.lastSuccessAt = null;
  memory.lastFailureAt = null;
  memory.lastFailureMessage = null;
  memory.lastFailureOperation = null;
  memory.consecutiveFailures = 0;
  memory.successes = 0;
  memory.failures = 0;
}

/**
 * The state machine, as a pure function of what is configured and what happened.
 *
 * Split out from the module memory so the DEGRADED branch — the one that only
 * occurs on a deployment that has a key, which no test environment does — is
 * reachable from a test without a key or a network call.
 */
export function deriveState(input: {
  configured: boolean;
  consecutiveFailures: number;
  hasSucceeded: boolean;
}): AiProviderState {
  if (!input.configured) return 'NOT_CONFIGURED';
  if (input.consecutiveFailures > 0) return 'DEGRADED';
  if (input.hasSucceeded) return 'HEALTHY';
  return 'UNVERIFIED';
}

function stateOf(): AiProviderState {
  return deriveState({
    configured: hasOpenAi,
    consecutiveFailures: memory.consecutiveFailures,
    hasSucceeded: memory.lastSuccessAt !== null,
  });
}

/**
 * The sentence an operator can act on.
 *
 * Each one names the thing to change. "AI is unavailable" would be true and
 * useless; the point of this whole module is that the four states have four
 * different remedies.
 */
function explain(state: AiProviderState): string {
  switch (state) {
    case 'NOT_CONFIGURED':
      return 'No OPENAI_API_KEY is set on this deployment, so every generator uses the built-in ' +
        'template engine. This is a supported mode, not a failure: output is produced from the ' +
        'brand context by rule rather than by a language model, and is labelled as such wherever ' +
        'it is shown. Set OPENAI_API_KEY (and optionally OPENAI_MODEL) to use a model.';
    case 'UNVERIFIED':
      return `OPENAI_API_KEY is set and no generation has been attempted since this process started, ` +
        `so the key has not been exercised. Run the provider check to confirm the key and that ` +
        `${env.OPENAI_MODEL} is reachable for this account.`;
    case 'HEALTHY':
      return `OPENAI_API_KEY is set and the last provider call to ${env.OPENAI_MODEL} succeeded.`;
    case 'DEGRADED':
      return `OPENAI_API_KEY is set but the last ${memory.consecutiveFailures} provider call(s) failed, ` +
        `so generations are silently falling back to the built-in template engine. ` +
        `Last error: ${memory.lastFailureMessage ?? 'unknown'}`;
  }
}

export interface AiHealth {
  state: AiProviderState;
  detail: string;
  /** True only for DEGRADED: configured, paid for, and not actually being used. */
  degraded: boolean;
  keyConfigured: boolean;
  model: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  lastFailureOperation: string | null;
  consecutiveFailures: number;
  callsThisProcess: { succeeded: number; failed: number };
}

export function aiHealth(): AiHealth {
  const state = stateOf();
  return {
    state,
    detail: explain(state),
    degraded: state === 'DEGRADED',
    keyConfigured: hasOpenAi,
    model: hasOpenAi ? env.OPENAI_MODEL : 'template-v1',
    lastSuccessAt: memory.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: memory.lastFailureAt?.toISOString() ?? null,
    lastFailureMessage: memory.lastFailureMessage,
    lastFailureOperation: memory.lastFailureOperation,
    consecutiveFailures: memory.consecutiveFailures,
    callsThisProcess: { succeeded: memory.successes, failed: memory.failures },
  };
}

export interface ProviderProbe {
  reachable: boolean;
  state: AiProviderState;
  detail: string;
  model: string;
  latencyMs: number;
}

/**
 * Ask the provider whether the configured model is actually usable.
 *
 * `models.retrieve` rather than a completion: it exercises the same credential
 * and the same model name, costs no tokens, and cannot produce content that
 * somebody might mistake for a generation. A completion would be a more
 * faithful test and a worse diagnostic — a quota error and a model-permission
 * error would arrive looking the same.
 *
 * The probe deliberately does not update the success memory: a reachable model
 * is not evidence that generation works, and marking the provider HEALTHY on a
 * metadata read would paper over exactly the failure this module exists to
 * expose. A failure *is* recorded, because a key that cannot read its own model
 * cannot generate with it either.
 */
export async function probeProvider(): Promise<ProviderProbe> {
  const started = Date.now();

  if (!hasOpenAi) {
    return {
      reachable: false,
      state: 'NOT_CONFIGURED',
      detail: explain('NOT_CONFIGURED'),
      model: 'template-v1',
      latencyMs: 0,
    };
  }

  try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 15_000, maxRetries: 0 });
    await client.models.retrieve(env.OPENAI_MODEL);
    return {
      reachable: true,
      state: stateOf(),
      detail: `${env.OPENAI_MODEL} is reachable with the configured key.`,
      model: env.OPENAI_MODEL,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    recordProviderFailure('probe', error);
    return {
      reachable: false,
      state: 'DEGRADED',
      detail:
        `The configured key could not reach ${env.OPENAI_MODEL}: ` +
        `${redact((error as Error)?.message ?? String(error))}. ` +
        'Until this is fixed every generation falls back to the built-in template engine.',
      model: env.OPENAI_MODEL,
      latencyMs: Date.now() - started,
    };
  }
}
