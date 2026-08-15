/**
 * Theme: dark / light / system, plus optional per-client brand skinning.
 *
 * When a client's brand identity is applied, its approved colours replace the
 * brand, accent and secondary tokens for the whole app, which is how a client
 * portal ends up looking like the client rather than like us.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BrandColors } from './api';

export type ThemeMode = 'dark' | 'light' | 'system';

interface ThemeValue {
  mode: ThemeMode;
  resolved: 'dark' | 'light';
  setMode: (mode: ThemeMode) => void;
  applyBrand: (brand: BrandColors | null) => void;
  brand: BrandColors | null;
}

const ThemeContext = createContext<ThemeValue | null>(null);

/** '#6366F1' → '99 102 241' for the `rgb(var(--x) / <alpha>)` pattern. */
function toRgbTriple(hex: string): string | null {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function readStored(): ThemeMode {
  const stored = localStorage.getItem('rmos.theme');
  return stored === 'light' || stored === 'system' || stored === 'dark' ? stored : 'dark';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStored);
  const [resolved, setResolved] = useState<'dark' | 'light'>(() =>
    readStored() === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : (readStored() as 'dark' | 'light'),
  );
  const [brand, setBrand] = useState<BrandColors | null>(null);

  useEffect(() => {
    const apply = () => {
      const next = mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode;
      setResolved(next);
      document.documentElement.dataset.theme = next;
    };
    apply();
    localStorage.setItem('rmos.theme', mode);

    if (mode !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [mode]);

  const applyBrand = useCallback((next: BrandColors | null) => {
    setBrand(next);
    const root = document.documentElement;

    if (!next) {
      for (const token of ['--c-brand', '--c-accent', '--c-secondary', '--font-sans']) {
        root.style.removeProperty(token);
      }
      return;
    }

    const primary = toRgbTriple(next.primaryColor);
    const accent = toRgbTriple(next.accentColor);
    const secondary = toRgbTriple(next.secondaryColor);

    if (primary) root.style.setProperty('--c-brand', primary);
    if (accent) root.style.setProperty('--c-accent', accent);
    if (secondary) root.style.setProperty('--c-secondary', secondary);
    if (next.fontFamily) {
      // The font is a suggestion; fall back cleanly when it is not installed.
      root.style.setProperty('--font-sans', `'${next.fontFamily}', 'Inter', ui-sans-serif, system-ui`);
    }
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({ mode, resolved, setMode: setModeState, applyBrand, brand }),
    [mode, resolved, applyBrand, brand],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}
