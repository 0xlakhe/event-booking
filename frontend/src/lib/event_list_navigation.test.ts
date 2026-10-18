import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearEventListOrigin,
  clearPublicEventListCache,
  cachePublicEventList,
  cachePublicEventListAtRevision,
  consumeEventListOrigin,
  decrementCachedPublicListSeat,
  getCachedPublicEventList,
  getEventListSnapshotForOrigin,
  getPublicEventListCacheRevision,
  getEventListOriginForEvent,
  getEventListOriginForHref,
  invalidatePublicEventLists,
  rememberEventListOrigin,
} from "./event_list_navigation";

afterEach(() => {
  clearEventListOrigin();
  clearPublicEventListCache();
});

describe("event list return context", () => {
  it("caches exact query and page keys with bounded LRU eviction", () => {
    const snapshot = (title: string) => ({ items: [{ id: title } as never], total: 1 });
    cachePublicEventList("ceramics", 2, snapshot("ceramics-2"));
    cachePublicEventList("ceramics", 3, snapshot("ceramics-3"));
    expect(getCachedPublicEventList("ceramics", 2)?.items[0]?.id).toBe("ceramics-2");
    expect(getCachedPublicEventList("ceramics", 3)?.items[0]?.id).toBe("ceramics-3");
    expect(getCachedPublicEventList("music", 2)).toBeNull();
    for (let page = 1; page <= 8; page += 1) {
      cachePublicEventList("other", page, snapshot(`other-${page}`));
    }
    expect(getCachedPublicEventList("ceramics", 3)).toBeNull();
    expect(getCachedPublicEventList("other", 8)?.items[0]?.id).toBe("other-8");
  });

  it("expires public list entries and clears them on invalidation", () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    cachePublicEventList("ceramics", 1, { items: [], total: 0 });
    now += 30_001;
    expect(getCachedPublicEventList("ceramics", 1)).toBeNull();
    cachePublicEventList("music", 2, { items: [], total: 0 });
    invalidatePublicEventLists();
    expect(getCachedPublicEventList("music", 2)).toBeNull();
  });

  it("does not repopulate list results from before invalidation", () => {
    const revision = getPublicEventListCacheRevision();
    invalidatePublicEventLists();
    cachePublicEventListAtRevision("ceramics", 1, { items: [], total: 1 }, revision);

    expect(getCachedPublicEventList("ceramics", 1)).toBeNull();
  });

  it("removes the booked seat from every cached list that shows the event", () => {
    const row = (id: string, seatsLeft: number) => ({ id, seats_left: seatsLeft } as never);
    cachePublicEventList("ceramics", 2, { items: [row("booked", 1), row("other", 5)], total: 2 });
    cachePublicEventList("music", 1, { items: [row("other", 5)], total: 1 });

    decrementCachedPublicListSeat("booked");

    expect(getCachedPublicEventList("ceramics", 2)?.items).toMatchObject([
      { id: "booked", seats_left: 0 },
      { id: "other", seats_left: 5 },
    ]);
    expect(getCachedPublicEventList("music", 1)?.items).toMatchObject([{ id: "other", seats_left: 5 }]);

    // Re-booking the same event must not push the count below zero.
    decrementCachedPublicListSeat("booked");
    expect(getCachedPublicEventList("ceramics", 2)?.items[0]).toMatchObject({ seats_left: 0 });
  });

  it("discards list responses captured before a booking correction", () => {
    const snapshot = (seatsLeft: number) => ({
      items: [{ id: "booked", seats_left: seatsLeft } as never],
      total: 1,
    });
    cachePublicEventList("", 1, snapshot(2));
    const staleRevision = getPublicEventListCacheRevision();

    decrementCachedPublicListSeat("booked");
    expect(getCachedPublicEventList("", 1)?.items[0]).toMatchObject({ seats_left: 1 });

    // A list response that started before the booking carries the old count…
    expect(cachePublicEventListAtRevision("", 1, snapshot(2), staleRevision)).toBe(false);
    // …and must not replace the corrected row.
    expect(getCachedPublicEventList("", 1)?.items[0]).toMatchObject({ seats_left: 1 });
  });

  it("keeps a corrected list row's freshness window unchanged", () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    cachePublicEventList("", 1, { items: [{ id: "booked", seats_left: 2 } as never], total: 1 });
    now += 10_000;

    decrementCachedPublicListSeat("booked");
    expect(getCachedPublicEventList("", 1)?.items[0]).toMatchObject({ seats_left: 1 });

    now += 20_001;
    expect(getCachedPublicEventList("", 1)).toBeNull();
  });

  it("shares the origin snapshot and pins it during bounded eviction", () => {
    const original = { items: [{ id: "origin" } as never], total: 1 };
    cachePublicEventList("ceramics", 3, original);
    rememberEventListOrigin("origin", "/?q=ceramics&page=3", 420, original);
    const context = getEventListOriginForEvent("origin");
    for (let page = 1; page <= 9; page += 1) {
      cachePublicEventList("other", page, { items: [], total: page });
    }
    expect(getEventListSnapshotForOrigin(context!)).toBe(original);
  });

  it("preserves the exact public-list query and hash for its matching event", () => {
    rememberEventListOrigin("event-1", "/?q=ceramics&page=3#events", 420);

    expect(getEventListOriginForEvent("event-1")?.href).toBe("/?q=ceramics&page=3#events");
    expect(getEventListOriginForHref("/?q=ceramics&page=3#events")?.scrollY).toBe(420);
    expect(getEventListOriginForEvent("event-2")).toBeNull();
    expect(getEventListOriginForHref("/?page=3&q=ceramics#events")).toBeNull();
  });

  it("rejects external, non-list, and protocol-relative return URLs", () => {
    rememberEventListOrigin("event-1", "https://attacker.invalid/", 420);
    expect(getEventListOriginForEvent("event-1")).toBeNull();

    rememberEventListOrigin("event-1", "//attacker.invalid/", 420);
    expect(getEventListOriginForEvent("event-1")).toBeNull();

    rememberEventListOrigin("event-1", "/admin?returnTo=/", 420);
    expect(getEventListOriginForEvent("event-1")).toBeNull();
  });

  it("does not expose an expired list snapshot for restoration", () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    rememberEventListOrigin("event-1", "/?q=ceramics&page=3", 420, {
      items: [],
      total: 0,
    });

    now += 30 * 60_000 + 1;
    expect(getEventListOriginForHref("/?q=ceramics&page=3")).toBeNull();
  });

  it("consumes only the exact restored origin", () => {
    rememberEventListOrigin("event-1", "/?q=ceramics&page=3", 420);
    const restoredOrigin = getEventListOriginForHref("/?q=ceramics&page=3");
    expect(restoredOrigin).not.toBeNull();

    rememberEventListOrigin("event-2", "/?q=music&page=1", 180);
    consumeEventListOrigin(restoredOrigin!);

    expect(getEventListOriginForEvent("event-2")?.scrollY).toBe(180);
    consumeEventListOrigin(getEventListOriginForEvent("event-2")!);
    expect(getEventListOriginForEvent("event-2")).toBeNull();
  });
});
