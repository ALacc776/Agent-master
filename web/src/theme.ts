import { useSyncExternalStore } from 'react';

// Per-viewer appearance (kept in this browser only).
export type Appearance = 'system' | 'light' | 'dark';
export type Accent = 'graphite' | 'orange' | 'purple' | 'pink' | 'green' | 'teal' | 'blue';

export const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: 'graphite', label: 'Graphite', swatch: '#8e8e93' },
  { id: 'orange', label: 'Orange', swatch: '#ff9500' },
  { id: 'purple', label: 'Purple', swatch: '#af52de' },
  { id: 'pink', label: 'Pink', swatch: '#ff2d55' },
  { id: 'green', label: 'Green', swatch: '#28b446' },
  { id: 'teal', label: 'Teal', swatch: '#00a8a8' },
  { id: 'blue', label: 'Blue', swatch: '#007aff' },
];

interface ThemeState {
  appearance: Appearance;
  accent: Accent;
}

const read = <T extends string>(key: string, fallback: T): T => {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
};

let theme: ThemeState = { appearance: read('masterAppearance', 'system'), accent: read('masterAccent', 'graphite') };
const listeners = new Set<() => void>();
const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;

function apply() {
  const dark = theme.appearance === 'dark' || (theme.appearance === 'system' && !!media?.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.accent = theme.accent;
}

export function initTheme() {
  apply();
  media?.addEventListener('change', apply);
}

export function setTheme(patch: Partial<ThemeState>) {
  theme = { ...theme, ...patch };
  try {
    localStorage.setItem('masterAppearance', theme.appearance);
    localStorage.setItem('masterAccent', theme.accent);
  } catch {
    /* storage unavailable */
  }
  apply();
  listeners.forEach((l) => l());
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => theme,
  );
}
