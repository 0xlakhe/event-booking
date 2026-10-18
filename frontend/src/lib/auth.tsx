"use client";

/* Session auth state: token in sessionStorage, validated on hydration.
   Never logged, never placed in URLs. 401 anywhere clears the session. */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiRequestError, api, type User } from "./api";
import { dropToken, readToken, writeToken } from "./token_store";
import { clearOwnBookingsCache } from "./own_bookings_cache";

interface AuthState {
  user: User | null;
  ready: boolean;
  expired: boolean;
  error: string | null;
  sessionIdentity: string | null;
  login(email: string, password: string): Promise<User>;
  register(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  markSessionExpired(): void;
  clearError(): void;
  /** Current bearer token for API calls, or null when signed out. */
  getToken(): string | null;
}

const AuthContext = createContext<AuthState | null>(null);

export function friendlyAuthMessage(code: string, fallback: string): string {
  switch (code) {
    case "INVALID_CREDENTIALS":
      return "Invalid email or password.";
    case "EMAIL_EXISTS":
      return "An account with this email already exists.";
    case "INVALID_SESSION":
      return "Your session has expired. Please log in again.";
    case "EVENT_FULL":
      return "This event is full.";
    case "ADMIN_BOOKING_FORBIDDEN":
      return "Booking actions are not available to administrators.";
    default:
      return fallback;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionIdentity, setSessionIdentity] = useState<string | null>(null);
  // Monotonic generation for auth operations. Every login, logout, or
  // expiry starts a new generation and invalidates the continuations of
  // earlier ones, so a slow restoration or logout for a previous account
  // can neither overwrite a newer login nor clear its session.
  const generation = useRef(0);

  const clearSession = useCallback(() => {
    dropToken();
    clearOwnBookingsCache();
    setSessionIdentity(null);
    setUser(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const stored = readToken();
    if (!stored) {
      setReady(true);
      return;
    }
    // Capture the initiating session and generation: a login, logout, or
    // expiry after this point makes the restoration stale, so it must not
    // set a user over a newer session or clear that session on its 401.
    const attempt = generation.current;
    api
      .me(stored)
      .then((me) => {
        if (cancelled || generation.current !== attempt) return;
        clearOwnBookingsCache();
        setSessionIdentity(globalThis.crypto.randomUUID());
        setUser(me);
      })
      .catch((err: unknown) => {
        if (cancelled || generation.current !== attempt) return;
        // Only an explicit 401 retires the session. Network and server
        // failures keep the stored token so a later retry can still
        // validate or revoke it instead of orphaning it.
        if (err instanceof ApiRequestError && err.status === 401) {
          clearSession();
          setExpired(true);
        }
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [clearSession]);

  const login = useCallback(
    async (email: string, password: string): Promise<User> => {
      // A new login supersedes any in-flight restoration, logout, or
      // earlier login so their continuations cannot clobber this one.
      const attempt = ++generation.current;
      setError(null);
      setExpired(false);
      try {
        const result = await api.login(email, password);
        if (generation.current !== attempt) return result.user;
        const persistence = writeToken(result.access_token);
        clearOwnBookingsCache();
        setSessionIdentity(globalThis.crypto.randomUUID());
        setUser(result.user);
        // A successful current login finalizes authentication readiness on
        // its own. A still-pending restoration for an older session must
        // not keep the app on "loading" after this session is established.
        setReady(true);
        if (persistence === "memory-only") {
          setError("Signed in for this tab only: this browser would not keep the session.");
        }
        return result.user;
      } catch (err: unknown) {
        if (generation.current !== attempt) throw err;
        if (err instanceof ApiRequestError) setError(friendlyAuthMessage(err.code, err.message));
        else setError("Login failed. Please try again.");
        throw err;
      }
    },
    [],
  );

  const register = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      await api.register(email, password);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(friendlyAuthMessage(err.code, err.message));
      else setError("Registration failed. Please try again.");
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    // Starting a logout supersedes earlier operations, and a newer login
    // started while the revocation is in flight supersedes this one: only
    // the still-current logout may clear local state.
    const attempt = ++generation.current;
    // Read before revoking: the in-memory fallback keeps the token even
    // when sessionStorage itself is broken, so the server session can
    // still be revoked instead of orphaned.
    const stored = readToken();
    clearSession();
    setExpired(false);
    try {
      if (stored) await api.logout(stored);
    } catch {
      if (generation.current === attempt) {
        setError("Signed out on this device, but the server session may still be active.");
      }
    } finally {
      if (generation.current === attempt) {
        clearSession();
        setExpired(false);
      }
    }
  }, [clearSession]);

  const markSessionExpired = useCallback(() => {
    // Expiry supersedes in-flight operations too, so none of them can
    // resurrect the retired session afterwards.
    generation.current += 1;
    clearSession();
    setExpired(true);
  }, [clearSession]);

  const clearError = useCallback(() => setError(null), []);

  const getToken = useCallback(() => readToken(), []);

  const value = useMemo<AuthState>(
    () => ({ user, ready, expired, error, sessionIdentity, login, register, logout, markSessionExpired, clearError, getToken }),
    [user, ready, expired, error, sessionIdentity, login, register, logout, markSessionExpired, clearError, getToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) throw new Error("useAuth must be used inside AuthProvider");
  return state;
}
