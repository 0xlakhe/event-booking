import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "./api";

const { apiMock } = vi.hoisted(() => ({ apiMock: { getEvent: vi.fn() } }));

vi.mock("./api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./api")>();
  return { ...mod, api: { ...mod.api, ...apiMock } };
});

import {
  getCachedPublicEventDetail,
  invalidatePublicEventDetail,
  loadPublicEventDetail,
  prefetchPublicEventDetail,
} from "./public_event_cache";

function detail(eventId: string): EventDetail {
  return {
    id: eventId,
    title: `Event ${eventId}`,
    description: "Public description",
    starts_at: "2030-01-01T10:00:00Z",
    venue: "Hall",
    total_seats: 8,
    seats_left: 7,
  };
}

beforeEach(() => {
  apiMock.getEvent.mockReset();
  for (const eventId of ["cache-ttl", ...Array.from({ length: 22 }, (_, index) => `cache-size-${index}`), "cache-invalidated"]) {
    invalidatePublicEventDetail(eventId);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public event detail cache", () => {
  it("expires cached detail after its bounded lifetime", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    apiMock.getEvent.mockResolvedValue(detail("cache-ttl"));

    await loadPublicEventDetail("cache-ttl");
    expect(getCachedPublicEventDetail("cache-ttl")?.id).toBe("cache-ttl");

    now += 90_001;
    expect(getCachedPublicEventDetail("cache-ttl")).toBeNull();
  });

  it("evicts oldest public details when the cache reaches its size bound", async () => {
    apiMock.getEvent.mockImplementation(async (eventId: string) => detail(eventId));
    for (let index = 0; index < 21; index += 1) {
      await loadPublicEventDetail(`cache-size-${index}`);
    }

    expect(getCachedPublicEventDetail("cache-size-0")).toBeNull();
    expect(getCachedPublicEventDetail("cache-size-20")?.id).toBe("cache-size-20");
  });

  it("does not repopulate a cache entry from a prefetch invalidated mid-flight", async () => {
    let resolveDetail!: (event: EventDetail) => void;
    apiMock.getEvent.mockImplementation(
      () => new Promise((resolve) => void (resolveDetail = resolve)),
    );
    prefetchPublicEventDetail("cache-invalidated");
    invalidatePublicEventDetail("cache-invalidated");

    resolveDetail(detail("cache-invalidated"));
    await vi.waitFor(() => expect(apiMock.getEvent).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(getCachedPublicEventDetail("cache-invalidated")).toBeNull();
  });

  it("starts a fresh load instead of treating an in-flight prefetch as current availability", async () => {
    let resolvePrefetch!: (event: EventDetail) => void;
    let resolveLoad!: (event: EventDetail) => void;
    apiMock.getEvent
      .mockImplementationOnce(() => new Promise((resolve) => void (resolvePrefetch = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => void (resolveLoad = resolve)));
    prefetchPublicEventDetail("cache-invalidated");

    const freshLoad = loadPublicEventDetail("cache-invalidated");
    expect(apiMock.getEvent).toHaveBeenCalledTimes(2);
    resolveLoad({ ...detail("cache-invalidated"), seats_left: 4 });
    await expect(freshLoad).resolves.toMatchObject({ seats_left: 4 });
    resolvePrefetch({ ...detail("cache-invalidated"), seats_left: 1 });
    await Promise.resolve();

    expect(getCachedPublicEventDetail("cache-invalidated")?.seats_left).toBe(4);
  });
});
