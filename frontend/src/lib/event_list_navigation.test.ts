import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearEventListOrigin,
  consumeEventListOrigin,
  getEventListOriginForEvent,
  getEventListOriginForHref,
  rememberEventListOrigin,
} from "./event_list_navigation";

afterEach(clearEventListOrigin);

describe("event list return context", () => {
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
