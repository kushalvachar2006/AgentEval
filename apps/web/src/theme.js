import { useSyncExternalStore } from 'react';

// Theme = user preference ('system' | 'light' | 'dark') resolved to 'light' | 'dark' on <html data-theme>.
// public/theme-init.js applies the same logic before first paint.
const KEY = 'agenteval.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

const readPref = () => {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
};
let pref = readPref();
const resolve = (p) => (p === 'system' ? (media.matches ? 'dark' : 'light') : p);

function apply() {
  const resolved = resolve(pref);
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.style.colorScheme = resolved;
  listeners.forEach((l) => l());
}
media.addEventListener('change', () => { if (pref === 'system') apply(); });
apply();

export function setThemePreference(next) {
  pref = next;
  try { if (next === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch { /* storage blocked: the choice lasts for this tab only */ }
  apply();
}

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const snapshot = () => `${pref}|${resolve(pref)}`;

export function useTheme() {
  const [preference, resolved] = useSyncExternalStore(subscribe, snapshot).split('|');
  return { preference, resolved, setPreference: setThemePreference };
}
