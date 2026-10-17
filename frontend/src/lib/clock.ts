"use client";

/* Wall-clock time refreshed on an interval. Time-based eligibility (an
 * event's start) therefore changes on screen without a reload. Display
 * gating only: the backend re-checks its own clock and stays
 * authoritative for every mutation. */

import { useEffect, useState } from "react";

export const ELIGIBILITY_TICK_MS = 30_000;

export function useNow(intervalMs: number = ELIGIBILITY_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return now;
}

/** True once `starts_at` has arrived, comparing instants. */
export function hasStarted(startsAt: string, now: number): boolean {
  const start = Date.parse(startsAt);
  return Number.isFinite(start) && start <= now;
}
