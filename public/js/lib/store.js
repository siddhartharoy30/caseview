/**
 * Local preferences.
 *
 * Column layout, saved views, density, theme and the sidebar state live here.
 * This is preference data only — no case content is ever written to
 * localStorage, because that would put customer data outside the cache we
 * control.
 */

const PREFIX = "qview.";

export function get(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function set(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota or private mode: preferences simply do not persist */
  }
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}

/** Reads once, applies a mutation, writes back. */
export function update(key, fallback, fn) {
  const next = fn(get(key, fallback));
  set(key, next);
  return next;
}
