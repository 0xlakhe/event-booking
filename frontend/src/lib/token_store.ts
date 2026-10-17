/**
 * Token persistence with an in-memory fallback.
 *
 * sessionStorage can be unavailable or throw (private mode, disabled
 * storage, quotas). The in-memory token is authoritative for the current
 * session: writes and restored reads are retained there, so a storage
 * failure can neither substitute an older stored token nor lose the
 * active one needed for server revocation. Callers report a
 * "memory-only" status visibly instead of failing silently.
 * The backend is resolved per call (never captured) so tests and
 * unusual environments can substitute or remove sessionStorage.
 */

export const TOKEN_STORAGE_KEY = "eventbook.token";

export type TokenPersistence = "persisted" | "memory-only";

interface TokenBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function backend(): TokenBackend | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

let memoryToken: string | null = null;
// Set by dropToken(): the session ended. A later storage read must never
// resurrect a token dropped after it was stored (e.g. when removeItem
// itself throws). Any new write starts a fresh session and clears it.
let retired = false;

export function readToken(): string | null {
  // The in-memory token is authoritative: it is always the session this
  // tab established or adopted, while storage may hold an older token a
  // failed write did not replace — or a dropped one a failed removal
  // did not delete.
  if (memoryToken !== null) return memoryToken;
  if (retired) return null;
  const store = backend();
  if (store === null) return null;
  try {
    const stored = store.getItem(TOKEN_STORAGE_KEY);
    // Retain restored sessions: a later storage failure must not lose
    // the active token and skip server revocation.
    if (stored !== null) memoryToken = stored;
    return stored;
  } catch {
    return memoryToken;
  }
}

export function writeToken(token: string): TokenPersistence {
  memoryToken = token;
  retired = false;
  const store = backend();
  if (store === null) return "memory-only";
  try {
    store.setItem(TOKEN_STORAGE_KEY, token);
    return "persisted";
  } catch {
    return "memory-only";
  }
}

export function dropToken(): void {
  memoryToken = null;
  retired = true;
  const store = backend();
  if (store === null) return;
  try {
    store.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* memory already cleared; nothing left to lose */
  }
}

/** Test-only reset to pristine tab state. Component tests share one
 * module registry per file, so without this a token adopted in one
 * test would leak into the next test's hydration. */
export function resetTokenStoreForTests(): void {
  memoryToken = null;
  retired = false;
}
