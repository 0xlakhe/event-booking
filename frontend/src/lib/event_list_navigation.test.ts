import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearEventListOrigin,
  clearPublicEventListCache,
  cachePublicEventList,
  consumeEventListOrigin,
  getCachedPublicEventList,
  getEventListSnapshotForOrigin,
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
    now += 30 * 60_000 + 1;
    expect(getCachedPublicEventList("ceramics", 1)).toBeNull();
    cachePublicEventList("music", 2, { items: [], total: 0 });
    invalidatePublicEventLists();
    expect(getCachedPublicEventList("music", 2)).toBeNull();
  });

  it("shares the origin snapshot and pins it during bounded eviction", () => {
    const original = { items: [{ id: "origin" } as never], total: 1 };
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
