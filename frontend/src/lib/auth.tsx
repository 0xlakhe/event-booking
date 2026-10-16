"use client";

/* Session auth state: token in sessionStorage, validated on hydration.
   Never logged, never placed in URLs. 401 anywhere clears the session. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ApiRequestError, api, type User } from "./api";

const STORAGE_KEY = "eventbook.token";

interface AuthState {
  user: User | null;
  ready: boolean;
  expired: boolean;
  error: string | null;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  markSessionExpired(): void;
  clearError(): void;
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
    default:
      return fallback;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearSession = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable: in-memory state still clears */
    }
    setUser(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (!stored) {
      setReady(true);
      return;
    }
    api
      .me(stored)
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        clearSession();
        if (err instanceof ApiRequestError && err.status === 401) setExpired(true);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [clearSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      setError(null);
      setExpired(false);
      try {
        const result = await api.login(email, password);
        try {
          sessionStorage.setItem(STORAGE_KEY, result.access_token);
        } catch {
          /* private mode: session lasts for this tab only */
        }
        setUser(result.user);
      } catch (err: unknown) {
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
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      stored = null;
    }
    try {
      if (stored) await api.logout(stored);
    } catch {
      setError("Signed out on this device, but the server session may still be active.");
    } finally {
      clearSession();
      setExpired(false);
    }
  }, [clearSession]);

  const markSessionExpired = useCallback(() => {
    clearSession();
    setExpired(true);
  }, [clearSession]);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AuthState>(
    () => ({ user, ready, expired, error, login, register, logout, markSessionExpired, clearError }),
    [user, ready, expired, error, login, register, logout, markSessionExpired, clearError],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) throw new Error("useAuth must be used inside AuthProvider");
  return state;
}
