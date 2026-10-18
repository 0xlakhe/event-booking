import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheAdminEventList,
  clearAdminEventListCache,
  getAdminEventListCacheRevision,
  getCachedAdminEventList,
  invalidateAdminEventLists,
} from "./admin_event_cache";

function body(id: string) {
  return {
    items: [
      {
        id,
        title: id,
        description: `${id} description.`,
        starts_at: "2030-01-01T10:00:00Z",
        venue: "Hall",
        total_seats: 10,
        seats_left: 9,
      },
    ],
    page: 1,
    page_size: 10,
    total: 1,
  };
}

afterEach(() => {
  clearAdminEventListCache();
  vi.useRealTimers();
});

describe("admin event list cache", () => {
  it("isolates session, filter, query, and page keys and expires entries", () => {
    vi.useFakeTimers();
    cacheAdminEventList("admin-a", "", "upcoming", 1, body("a-up"));
    cacheAdminEventList("admin-a", "", "past", 1, body("a-past"));
    cacheAdminEventList("admin-a", "gala", "all", 2, body("a-gala"));
    cacheAdminEventList("admin-b", "", "upcoming", 1, body("b-up"));

    expect(getCachedAdminEventList("admin-a", "", "upcoming", 1)?.items[0]?.id).toBe("a-up");
    expect(getCachedAdminEventList("admin-a", "", "past", 1)?.items[0]?.id).toBe("a-past");
    expect(getCachedAdminEventList("admin-a", "gala", "all", 2)?.items[0]?.id).toBe("a-gala");
    expect(getCachedAdminEventList("admin-b", "", "upcoming", 1)?.items[0]?.id).toBe("b-up");
    // Other keys are never served another key's rows.
    expect(getCachedAdminEventList("admin-a", "", "all", 1)).toBeNull();
    expect(getCachedAdminEventList("admin-a", "gala", "upcoming", 1)).toBeNull();
    expect(getCachedAdminEventList("admin-b", "", "past", 1)).toBeNull();

    vi.advanceTimersByTime(30_001);
    expect(getCachedAdminEventList("admin-a", "", "upcoming", 1)).toBeNull();
  });

  it("bounds entries to the most recent results", () => {
    for (let page = 1; page <= 13; page += 1) {
      cacheAdminEventList("admin-a", "", "all", page, body(`page-${page}`));
    }
    expect(getCachedAdminEventList("admin-a", "", "all", 1)).toBeNull();
    expect(getCachedAdminEventList("admin-a", "", "all", 13)?.items[0]?.id).toBe("page-13");
  });

  it("keeps recently read entries ahead of older ones", () => {
    for (let page = 1; page <= 12; page += 1) {
      cacheAdminEventList("admin-a", "", "all", page, body(`page-${page}`));
    }
    // Reading page 1 refreshes its position, so the next insert evicts
    // page 2 rather than the entry that was just used.
    expect(getCachedAdminEventList("admin-a", "", "all", 1)).not.toBeNull();
    cacheAdminEventList("admin-a", "", "all", 13, body("page-13"));
    expect(getCachedAdminEventList("admin-a", "", "all", 2)).toBeNull();
    expect(getCachedAdminEventList("admin-a", "", "all", 1)?.items[0]?.id).toBe("page-1");
  });

  it("invalidates only the acting session and rejects pre-invalidation writes", () => {
    const revision = getAdminEventListCacheRevision();
    cacheAdminEventList("admin-a", "", "upcoming", 1, body("a-up"));
    cacheAdminEventList("admin-b", "", "upcoming", 1, body("b-up"));

    invalidateAdminEventLists("admin-a");
    expect(getCachedAdminEventList("admin-a", "", "upcoming", 1)).toBeNull();
    expect(getCachedAdminEventList("admin-b", "", "upcoming", 1)?.items[0]?.id).toBe("b-up");

    // A response that started before the invalidation cannot reinstall rows.
    cacheAdminEventList("admin-a", "", "past", 1, body("late"), revision);
    expect(getCachedAdminEventList("admin-a", "", "past", 1)).toBeNull();
  });
});
