import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheOwnBookings,
  clearOwnBookingsCache,
  getCachedOwnBookings,
  invalidateOwnBookings,
} from "./own_bookings_cache";

const body = (id: string) => ({ items: [{ id } as never], total: 1, page: 1, page_size: 10 });

afterEach(() => {
  clearOwnBookingsCache();
  vi.useRealTimers();
});

describe("current-session bookings cache", () => {
  it("isolates session and page keys, and expires entries", () => {
    vi.useFakeTimers();
    cacheOwnBookings("session-a", 1, body("a-1"));
    cacheOwnBookings("session-a", 2, body("a-2"));
    cacheOwnBookings("session-b", 1, body("b-1"));
    expect(getCachedOwnBookings("session-a", 1)?.items[0]?.id).toBe("a-1");
    expect(getCachedOwnBookings("session-a", 2)?.items[0]?.id).toBe("a-2");
    expect(getCachedOwnBookings("session-b", 1)?.items[0]?.id).toBe("b-1");
    expect(getCachedOwnBookings("session-b", 2)).toBeNull();
    vi.advanceTimersByTime(60_001);
    expect(getCachedOwnBookings("session-a", 1)).toBeNull();
  });

  it("bounds entries and invalidates only the selected session", () => {
    for (let page = 1; page <= 9; page += 1) {
      cacheOwnBookings("session-a", page, body(`a-${page}`));
    }
    cacheOwnBookings("session-b", 1, body("b-1"));
    invalidateOwnBookings("session-a");
    expect(getCachedOwnBookings("session-a", 9)).toBeNull();
    expect(getCachedOwnBookings("session-b", 1)?.items[0]?.id).toBe("b-1");
  });
});
