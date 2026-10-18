/**
 * Detail-page action behavior. Lost-booking-response regression (Review
 * Focus #2): when a booking POST fails in a way that may have committed
 * server-side, the UI refetches the user's bookings before offering
 * another action — never an automatic POST retry. Also covers the
 * Booked state derived from booking history, which persists across
 * reloads.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail, EventSummary } from "../../../lib/api";
import { AuthProvider, useAuth } from "../../../lib/auth";
import { resetTokenStoreForTests } from "../../../lib/token_store";
import { getCachedPublicEventDetail, invalidatePublicEventDetail, loadPublicEventDetail } from "../../../lib/public_event_cache";
import {
  cachePublicEventList,
  clearEventListOrigin,
  clearPublicEventListCache,
  getCachedPublicEventList,
  rememberEventListOrigin,
} from "../../../lib/event_list_navigation";
import DetailPage from "./page";

const { routerMock, routeState } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  routeState: { id: "event-1" },
}));

vi.mock("next/navigation", () => ({
  useParams: () => routeState,
  useRouter: () => routerMock,
}));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getEvent: vi.fn(),
    createBooking: vi.fn(),
    myBookings: vi.fn(),
    me: vi.fn(),
    login: vi.fn(),
  },
}));

vi.mock("../../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/api")>();
  return { ...mod, api: { ...mod.api, ...apiMock } };
});

const EVENT: EventDetail = {
  id: "event-1",
  title: "Lockable Night",
  description: "A very bookable evening.",
  starts_at: "2030-01-01T10:00:00Z",
  venue: "Hall",
  total_seats: 10,
  seats_left: 9,
};

function signIn() {
  sessionStorage.setItem("eventbook.token", "tok-1");
  apiMock.me.mockResolvedValue({ id: "u-1", email: "a@example.com", role: "user" });
}

function renderSignedIn() {
  return render(
    <AuthProvider>
      <DetailPage />
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  invalidatePublicEventDetail(EVENT.id);
  // Reset, not just clear: implementations and once-queues left by a
  // previous — possibly failed — test must not leak into the next one.
  vi.resetAllMocks();
  vi.useRealTimers();
  routeState.id = "event-1";
  clearEventListOrigin();
  clearPublicEventListCache();
  sessionStorage.clear();
  resetTokenStoreForTests();
});

describe("event detail refresh context", () => {
  it("uses a fresh completed detail without a second availability request", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValueOnce(EVENT);
    await loadPublicEventDetail(EVENT.id);
    apiMock.getEvent.mockClear();
    apiMock.myBookings.mockResolvedValue({ items: [], total: 0 });

    renderSignedIn();

    expect(await screen.findByText("Lockable Night")).not.toBeNull();
    expect(screen.queryByText("Updating event…")).toBeNull();
    expect(screen.queryByText(/updating availability/i)).toBeNull();
    expect(apiMock.getEvent).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Book one seat" })).not.toBeNull();
    invalidatePublicEventDetail(EVENT.id);
  });

  it("reserves the detail layout during the initial event request without exposing actions", async () => {
    let resolveDetail!: (detail: EventDetail) => void;
    apiMock.getEvent.mockImplementation(
      () => new Promise((resolve) => void (resolveDetail = resolve)),
    );
    renderSignedIn();

    expect(screen.getByRole("status").textContent).toMatch(/loading event details/i);
    const skeleton = screen.getByTestId("event-detail-skeleton");
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(skeleton.querySelector(".skeleton-heading")).not.toBeNull();
    expect(skeleton.querySelector(".skeleton-description")).not.toBeNull();
    expect(skeleton.querySelector(".skeleton-booking-panel")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /book/i })).toBeNull();

    resolveDetail(EVENT);
    await screen.findByText("Lockable Night");
  });

  it("keeps same-route content visible while booking refreshes truthful availability", async () => {
    signIn();
    apiMock.myBookings.mockResolvedValue({ items: [], total: 0 });
    apiMock.createBooking.mockResolvedValue(undefined);
    apiMock.getEvent.mockResolvedValueOnce(EVENT);
    let resolveRefresh!: (detail: EventDetail) => void;
    apiMock.getEvent.mockImplementationOnce(
      () => new Promise((resolve) => void (resolveRefresh = resolve)),
    );
    renderSignedIn();
    await screen.findByText("Lockable Night");
    expect(getCachedPublicEventDetail(EVENT.id)?.seats_left).toBe(9);

    fireEvent.click(await screen.findByRole("button", { name: "Book one seat" }));

    expect((await screen.findByRole("status")).textContent).toMatch(/updating availability/i);
    expect(screen.getByText("Lockable Night")).not.toBeNull();
    expect(screen.getByText(/updating availability/i, { selector: "dd" })).not.toBeNull();
    expect(getCachedPublicEventDetail(EVENT.id)).toBeNull();
    resolveRefresh({ ...EVENT, seats_left: 8 });
    await screen.findByText("8 / 10 seats left");
    expect(screen.getByText("Lockable Night")).not.toBeNull();
  });

  it("does not show the previous event after the route id changes", async () => {
    apiMock.getEvent.mockResolvedValueOnce(EVENT);
    let resolveNext!: (detail: EventDetail) => void;
    apiMock.getEvent.mockImplementationOnce(
      () => new Promise((resolve) => void (resolveNext = resolve)),
    );
    const view = render(
      <AuthProvider>
        <DetailPage />
      </AuthProvider>,
    );
    await screen.findByText("Lockable Night");

    routeState.id = "event-2";
    view.rerender(
      <AuthProvider>
        <DetailPage />
      </AuthProvider>,
    );

    expect(screen.queryByText("Lockable Night")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/loading event details/i);
    resolveNext({ ...EVENT, id: "event-2", title: "Second Night" });
    await screen.findByText("Second Night");
  });

  it("does not carry the previous event's booked marker to a new route", async () => {
    signIn();
    apiMock.myBookings.mockResolvedValue({
      items: [{ event: { id: "event-1" } }],
      total: 1,
    });
    apiMock.getEvent.mockResolvedValueOnce(EVENT);
    apiMock.getEvent.mockResolvedValueOnce({ ...EVENT, id: "event-2", title: "Second Night" });
    const view = renderSignedIn();
    await screen.findByRole("button", { name: "Booked" });

    routeState.id = "event-2";
    view.rerender(
      <AuthProvider>
        <DetailPage />
      </AuthProvider>,
    );

    await screen.findByRole("button", { name: "Book one seat" });
  });

  it("keeps the originating search/page return available when detail loading fails", async () => {
    routeState.id = "failed-event";
    rememberEventListOrigin("failed-event", "/?q=ceramics&page=3", 480);
    apiMock.getEvent.mockRejectedValue(new TypeError("offline"));
    render(
      <AuthProvider>
        <DetailPage />
      </AuthProvider>,
    );

    await screen.findByRole("alert");
    const backLink = screen.getByRole("link", { name: "Back to events" });
    expect(backLink.getAttribute("href")).toBe("/?q=ceramics&page=3");
    fireEvent.click(backLink);
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });
});

describe("public list return after booking", () => {
  const listed: EventSummary = {
    id: EVENT.id,
    title: EVENT.title,
    starts_at: EVENT.starts_at,
    venue: EVENT.venue,
    total_seats: EVENT.total_seats,
    seats_left: EVENT.seats_left,
  };

  it("keeps the returning list cached with the booked seat removed", async () => {
    signIn();
    apiMock.myBookings.mockResolvedValue({ items: [], total: 0 });
    apiMock.createBooking.mockResolvedValue(undefined);
    apiMock.getEvent.mockResolvedValue(EVENT);
    cachePublicEventList("", 1, { items: [listed], total: 1 });

    renderSignedIn();
    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByRole("button", { name: "Book one seat" }));
    await screen.findByRole("button", { name: "Booked" });

    // The list the visitor returns to is corrected, not cleared: it keeps
    // rendering (and restoring its remembered scroll) and now shows the seat
    // this booking took.
    expect(getCachedPublicEventList("", 1)?.items[0]?.seats_left).toBe(8);
  });

  it("clears the returning list when the booking is rejected", async () => {
    const { ApiRequestError } = await import("../../../lib/api");
    signIn();
    apiMock.myBookings.mockResolvedValue({ items: [], total: 0 });
    apiMock.createBooking.mockRejectedValueOnce(
      new ApiRequestError(409, "EVENT_FULL", "This event just filled up."),
    );
    apiMock.getEvent.mockResolvedValue(EVENT);
    cachePublicEventList("", 1, { items: [listed], total: 1 });

    renderSignedIn();
    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByRole("button", { name: "Book one seat" }));
    await screen.findByText(/filled up/i);

    // A rejected booking can mean the cached capacity is wrong (someone else
    // took the last seat), so the returning list must refetch instead.
    expect(getCachedPublicEventList("", 1)).toBeNull();
  });
});

describe("lost booking response", () => {
  it("refetches history instead of retrying, then allows an explicit retry", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.myBookings.mockResolvedValue({ items: [], total: 0 });
    apiMock.createBooking.mockRejectedValueOnce(new TypeError("network down"));
    renderSignedIn();

    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByText("Book one seat"));
    // Recovery refetches history instead of retrying the POST …
    await screen.findByText(/nothing was booked/i);
    expect(apiMock.createBooking).toHaveBeenCalledTimes(1);
    // Once for the load-time booked check, once for recovery.
    expect(apiMock.myBookings).toHaveBeenCalledTimes(2);
    // …and the action stays available for an explicit retry.
    expect(await screen.findByText("Book one seat")).not.toBeNull();
  });

  it("confirms success when the lost booking actually committed", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.createBooking.mockRejectedValueOnce(new TypeError("network down"));
    // The load-time check sees no booking yet; the recovery scan after the
    // failed POST finds the booking that committed despite the lost reply.
    const committed = {
      id: "booking-9",
      event: EVENT,
      created_at: "2030-01-01T10:00:01Z",
    };
    let bookingCommitted = false;
    apiMock.myBookings.mockImplementation(async () =>
      bookingCommitted ? { items: [committed], total: 1 } : { items: [], total: 0 },
    );
    renderSignedIn();

    await screen.findByText("Lockable Night");
    await waitFor(() => expect(apiMock.myBookings).toHaveBeenCalledTimes(1));
    bookingCommitted = true;
    fireEvent.click(await screen.findByText("Book one seat"));
    await waitForIdle();
    expect(apiMock.createBooking).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/may have gone through/i)).toBeNull();
    // The confirmed booking flips the action to Booked.
    const button = await screen.findByRole("button", { name: "Booked" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("admin redirect", () => {
  it("sends admins to management only after restoration", async () => {
    routerMock.replace.mockClear();
    apiMock.getEvent.mockClear();
    sessionStorage.setItem("eventbook.token", "tok-admin");
    let resolveMe!: (user: unknown) => void;
    apiMock.me.mockImplementation(() => new Promise((resolve) => void (resolveMe = resolve)));
    render(
      <AuthProvider>
        <DetailPage />
      </AuthProvider>,
    );
    await new Promise((done) => setTimeout(done, 20));
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(apiMock.getEvent).not.toHaveBeenCalled();
    resolveMe({ id: "u-9", email: "boss@example.com", role: "admin" });
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/admin"));
    expect(apiMock.getEvent).not.toHaveBeenCalled();
  });
});

async function waitForIdle() {
  await new Promise((done) => setTimeout(done, 50));
}

/* Booking-session races: an outcome that belongs to the session that
 * started it must never touch a session that replaced it. */

const USER_A = { id: "u-A", email: "a@example.com", role: "user" };
const USER_B = { id: "u-B", email: "b@example.com", role: "user" };

function AccountHarness() {
  const { user, login } = useAuth();
  return (
    <>
      <DetailPage />
      <span data-testid="who">{user ? user.email : "signed-out"}</span>
      <button type="button" onClick={() => void login("b@example.com", "password-123")}>
        switch-b
      </button>
    </>
  );
}

function signInAsA() {
  sessionStorage.setItem("eventbook.token", "tok-A");
  apiMock.me.mockResolvedValue(USER_A);
}

function allowLoginB() {
  apiMock.login.mockResolvedValue({
    access_token: "tok-B",
    token_type: "bearer",
    expires_at: "2030-01-01T00:00:00Z",
    user: USER_B,
  });
}

function renderAccounts() {
  return render(
    <AuthProvider>
      <AccountHarness />
    </AuthProvider>,
  );
}

async function settle(ms = 20) {
  await new Promise((done) => setTimeout(done, ms));
}

describe("booking races across account switching", () => {
  it("does not expire the new session on the old booking's 401", async () => {
    signInAsA();
    allowLoginB();
    apiMock.getEvent.mockResolvedValue(EVENT);
    let rejectBooking!: (err: unknown) => void;
    apiMock.createBooking.mockImplementation(
      () => new Promise((_, reject) => void (rejectBooking = reject)),
    );
    renderAccounts();

    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByText("Book one seat"));
    fireEvent.click(screen.getByText("switch-b", { selector: "button" }));
    await screen.findByText("b@example.com");

    const { ApiRequestError } = await import("../../../lib/api");
    rejectBooking(new ApiRequestError(401, "INVALID_SESSION", "Invalid or expired session."));
    await settle();

    // B is still signed in; the stale 401 must not sign B out or redirect.
    expect(screen.getByText("b@example.com")).not.toBeNull();
    expect(routerMock.push).not.toHaveBeenCalledWith("/login");
  });

  it("does not update the new session on the old booking's success", async () => {
    invalidatePublicEventDetail(EVENT.id);
    signInAsA();
    allowLoginB();
    apiMock.getEvent.mockResolvedValue(EVENT);
    let resolveBooking!: (booking: unknown) => void;
    apiMock.createBooking.mockImplementation(
      () => new Promise((resolve) => void (resolveBooking = resolve)),
    );
    renderAccounts();

    await screen.findByText("Lockable Night");
    expect(getCachedPublicEventDetail(EVENT.id)).not.toBeNull();
    fireEvent.click(await screen.findByText("Book one seat"));
    fireEvent.click(screen.getByText("switch-b", { selector: "button" }));
    await screen.findByText("b@example.com");
    await settle();
    const before = apiMock.getEvent.mock.calls.length;

    resolveBooking({ id: "b-1", event: EVENT, created_at: "x" });
    await settle();

    // The stale success must not refetch or post feedback for B.
    expect(apiMock.getEvent.mock.calls.length).toBe(before);
    expect(getCachedPublicEventDetail(EVENT.id)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not update the new session from the old recovery response", async () => {
    signInAsA();
    allowLoginB();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.createBooking.mockRejectedValueOnce(new TypeError("network down"));
    // Each history call stays pending until the test resolves it by index:
    // 0 is A's load-time scan, 1 is A's recovery scan (the stale response).
    const historyResolvers: Array<(body: unknown) => void> = [];
    apiMock.myBookings.mockImplementation(
      () => new Promise((resolve) => void historyResolvers.push(resolve)),
    );
    renderAccounts();

    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByText("Book one seat"));
    await screen.findByText(/may have gone through/i);
    await waitFor(() => expect(historyResolvers).toHaveLength(2));
    fireEvent.click(screen.getByText("switch-b", { selector: "button" }));
    await screen.findByText("b@example.com");

    historyResolvers[1]({ items: [], total: 0 });
    await settle();

    expect(screen.queryByText(/nothing was booked/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("b@example.com")).not.toBeNull();
  });
});

describe("booking recovery verification", () => {
  it("expires the current session on a recovery 401", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.createBooking.mockRejectedValueOnce(new TypeError("network down"));
    const { ApiRequestError } = await import("../../../lib/api");
    apiMock.myBookings.mockRejectedValue(
      new ApiRequestError(401, "INVALID_SESSION", "Invalid or expired session."),
    );
    renderSignedIn();

    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByText("Book one seat"));

    await waitFor(() =>
      expect(
        screen.getByText((_, el) => el?.textContent === "Log in to book a seat."),
      ).not.toBeNull(),
    );
    expect(routerMock.push).toHaveBeenCalledWith("/login");
  });

  it("finds an active booking beyond the first page of history", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.createBooking.mockRejectedValueOnce(new TypeError("network down"));
    const filler = Array.from({ length: 10 }, (_, index) => ({
      id: `booking-${index}`,
      event: { ...EVENT, id: `other-${index}`, title: `Other ${index}` },
      created_at: "2030-01-01T00:00:00Z",
    }));
    const lastFiller = {
      id: "booking-other-10",
      event: { ...EVENT, id: "other-10", title: "Other 10" },
      created_at: "2030-01-01T00:00:00Z",
    };
    const target = {
      id: "booking-target",
      event: EVENT,
      created_at: "2030-01-01T00:00:00Z",
    };
    // The load-time scan sees two pages without a booking on this event;
    // after the failed POST the recovery scan finds the target on page two.
    let recoveryScan = false;
    apiMock.myBookings.mockImplementation(async (_token: string, page: number) => {
      if (page === 1) return { items: filler, total: 11 };
      return recoveryScan ? { items: [target], total: 11 } : { items: [lastFiller], total: 11 };
    });
    renderSignedIn();

    await screen.findByText("Lockable Night");
    await waitFor(() => expect(apiMock.myBookings).toHaveBeenCalledTimes(2));
    recoveryScan = true;
    fireEvent.click(await screen.findByText("Book one seat"));

    await waitFor(() => expect(apiMock.myBookings).toHaveBeenCalledWith("tok-1", 2, 10));
    expect(screen.queryByText(/nothing was booked/i)).toBeNull();
    expect(screen.queryByText(/couldn't confirm/i)).toBeNull();
    // Recovery found the target beyond page one and flipped the action…
    const button = await screen.findByRole("button", { name: "Booked" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // …after a second, two-page scan of the load-time check and recovery.
    expect(apiMock.myBookings).toHaveBeenCalledTimes(4);
  });

  it("reports an uncertain outcome when verification itself fails", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.createBooking.mockRejectedValueOnce(new TypeError("network down"));
    apiMock.myBookings.mockRejectedValue(new TypeError("history unavailable"));
    renderSignedIn();

    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByText("Book one seat"));

    // Verification could not complete: the outcome is uncertain, never a
    // definite "nothing was booked", and the POST is not retried.
    await screen.findByText(/couldn't confirm whether the booking went through/i);
    expect(screen.queryByText(/nothing was booked/i)).toBeNull();
    expect(apiMock.createBooking).toHaveBeenCalledTimes(1);
  });
});

describe("start-time eligibility", () => {
  it("disables booking once the event starts, without a reload", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2030-01-01T09:59:55Z"));
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    renderSignedIn();

    const button = await screen.findByRole("button", { name: "Book one seat" });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    const startedButton = screen.getByRole("button", { name: "Event started" });
    expect((startedButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/already started and can no longer be booked/i)).not.toBeNull();
  });
});

describe("booked state from history", () => {
  function activeBooking(event: EventDetail) {
    return {
      id: "booking-1",
      event,
      created_at: "2030-01-01T10:00:01Z",
    };
  }

  it("shows a disabled Booked button when history already has an active booking", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.myBookings.mockResolvedValue({ items: [activeBooking(EVENT)], total: 1 });
    renderSignedIn();

    const button = await screen.findByRole("button", { name: "Booked" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(apiMock.myBookings).toHaveBeenCalledWith("tok-1", 1, 10);
  });

  it("shows Booked after a successful booking click", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.myBookings.mockResolvedValue({ items: [], total: 0 });
    apiMock.createBooking.mockResolvedValue(activeBooking(EVENT));
    renderSignedIn();

    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByText("Book one seat"));

    const button = await screen.findByRole("button", { name: "Booked" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(apiMock.createBooking).toHaveBeenCalledTimes(1);
  });

  it("keeps Book one seat when current history has no booking", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.myBookings.mockResolvedValue({
      items: [],
      total: 0,
    });
    renderSignedIn();

    await screen.findByText("Lockable Night");
    await waitFor(() => expect(apiMock.myBookings).toHaveBeenCalledTimes(1));
    const button = screen.getByRole("button", { name: "Book one seat" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Booked" })).toBeNull();
  });

  it("prefers Booked over Event full for the last seat", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue({ ...EVENT, seats_left: 0 });
    apiMock.myBookings.mockResolvedValue({ items: [activeBooking(EVENT)], total: 1 });
    renderSignedIn();

    const button = await screen.findByRole("button", { name: "Booked" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Event full" })).toBeNull();
  });

  it("prefers Booked over Event started and drops the started note", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue({ ...EVENT, starts_at: "2020-01-01T10:00:00Z" });
    apiMock.myBookings.mockResolvedValue({ items: [activeBooking(EVENT)], total: 1 });
    renderSignedIn();

    const button = await screen.findByRole("button", { name: "Booked" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/already started and can no longer be booked/i)).toBeNull();
  });

  it("repairs Booked when the POST reports ALREADY_BOOKED", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.myBookings.mockResolvedValue({ items: [], total: 0 });
    const { ApiRequestError } = await import("../../../lib/api");
    apiMock.createBooking.mockRejectedValue(
      new ApiRequestError(409, "ALREADY_BOOKED", "Already booked."),
    );
    renderSignedIn();

    await screen.findByText("Lockable Night");
    await waitFor(() => expect(apiMock.myBookings).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText("Book one seat"));

    await screen.findByText(/already have an active booking/i);
    const button = await screen.findByRole("button", { name: "Booked" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not expire the session when the load-time check gets a 401", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    const { ApiRequestError } = await import("../../../lib/api");
    apiMock.myBookings.mockRejectedValue(
      new ApiRequestError(401, "INVALID_SESSION", "Invalid or expired session."),
    );
    renderSignedIn();

    await screen.findByText("Lockable Night");
    await waitFor(() => expect(apiMock.myBookings).toHaveBeenCalledTimes(1));
    // The scan is an enhancement, not an authority: its 401 must not force
    // the app-wide expiry redirect; the next authenticated action still can.
    expect(routerMock.push).not.toHaveBeenCalledWith("/login");
    const button = screen.getByRole("button", { name: "Book one seat" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not check history for signed-out visitors", async () => {
    apiMock.getEvent.mockResolvedValue(EVENT);
    renderSignedIn();

    await screen.findByText("Lockable Night");
    await waitForIdle();
    expect(apiMock.myBookings).not.toHaveBeenCalled();
    expect(
      screen.getByText((_, el) => el?.textContent === "Log in to book a seat."),
    ).not.toBeNull();
  });

  it("resets Booked when the account switches", async () => {
    signInAsA();
    allowLoginB();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.myBookings.mockImplementation((token: string) =>
      token === "tok-A"
        ? Promise.resolve({ items: [activeBooking(EVENT)], total: 1 })
        : Promise.resolve({ items: [], total: 0 }),
    );
    renderAccounts();

    await screen.findByRole("button", { name: "Booked" });
    fireEvent.click(screen.getByText("switch-b", { selector: "button" }));
    await screen.findByText("b@example.com");

    const button = await screen.findByRole("button", { name: "Book one seat" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Booked" })).toBeNull();
  });

  it("ignores a previous account's scan response after a switch", async () => {
    signInAsA();
    allowLoginB();
    apiMock.getEvent.mockResolvedValue(EVENT);
    let resolveA!: (body: unknown) => void;
    apiMock.myBookings.mockImplementation((token: string) =>
      token === "tok-A"
        ? new Promise((resolve) => void (resolveA = resolve))
        : Promise.resolve({ items: [], total: 0 }),
    );
    renderAccounts();

    await screen.findByText("Lockable Night");
    await waitFor(() => expect(apiMock.myBookings).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("switch-b", { selector: "button" }));
    await screen.findByText("b@example.com");
    resolveA({ items: [activeBooking(EVENT)], total: 1 });
    await waitForIdle();

    // The old account's confirmation must not mark the new session Booked.
    expect(screen.queryByRole("button", { name: "Booked" })).toBeNull();
    expect(screen.getByRole("button", { name: "Book one seat" })).not.toBeNull();
  });
});
