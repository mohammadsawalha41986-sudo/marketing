/** Small data-fetching primitives. Enough for this app; no cache library needed. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * GET a path and track loading/error. `deps` controls refetching; the request is
 * aborted if it changes mid-flight so a slow response cannot overwrite a newer one.
 */
export function useQuery<T>(path: string | null, deps: unknown[] = []): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const controller = useRef<AbortController>();

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;

    setLoading(true);
    setError(null);

    api
      .get<T>(path, next.signal)
      .then((result) => {
        if (!next.signal.aborted) setData(result);
      })
      .catch((err: unknown) => {
        if (next.signal.aborted || (err as Error).name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      })
      .finally(() => {
        if (!next.signal.aborted) setLoading(false);
      });

    return () => next.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const refetch = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, refetch };
}

/** Wraps a mutating call with pending state and normalised errors. */
export function useMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(
    async (input: TInput): Promise<TResult | null> => {
      setLoading(true);
      setError(null);
      try {
        return await fn(input);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [fn],
  );

  return { mutate, loading, error, setError };
}

/** Debounced value, for search inputs that drive requests. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Persisted UI preference, e.g. the currently selected client. */
export function useLocalState<T extends string>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => (localStorage.getItem(key) as T) ?? initial);
  const update = useCallback(
    (next: T) => {
      setValue(next);
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
    },
    [key],
  );
  return [value, update];
}
