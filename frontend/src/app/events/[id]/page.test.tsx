/**
 * Lost-booking-response regression (Review Focus #2): when a booking POST
 * fails in a way that may have committed server-side, the UI refetches
 * the user's bookings before offering another action — never an
 * automatic POST retry.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../lib/api";
import { AuthProvider, useAuth } from "../../../lib/auth";
import { resetTokenStoreForTests } from "../../../lib/token_store";
import DetailPage from "./page";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "event-1" }),
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
  vi.clearAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  resetTokenStoreForTests();
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
    expect(apiMock.myBookings).toHaveBeenCalledTimes(1);
    // …and the action stays available for an explicit retry.
    expect(await screen.findByText("Book one seat")).not.toBeNull();
  });

  it("confirms success when the lost booking actually committed", async () => {
    signIn();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.createBooking.mockRejectedValueOnce(new TypeError("network down"));
    apiMock.myBookings.mockResolvedValue({
      items: [
        {
          id: "booking-9",
          event: EVENT,
          created_at: "2030-01-01T10:00:01Z",
          cancelled_at: null,
        },
      ],
      total: 1,
    });
    renderSignedIn();

    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByText("Book one seat"));
    await waitForIdle();
    expect(apiMock.createBooking).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/may have gone through/i)).toBeNull();
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
    signInAsA();
    allowLoginB();
    apiMock.getEvent.mockResolvedValue(EVENT);
    let resolveBooking!: (booking: unknown) => void;
    apiMock.createBooking.mockImplementation(
      () => new Promise((resolve) => void (resolveBooking = resolve)),
    );
    renderAccounts();

    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByText("Book one seat"));
    fireEvent.click(screen.getByText("switch-b", { selector: "button" }));
    await screen.findByText("b@example.com");
    await settle();
    const before = apiMock.getEvent.mock.calls.length;

    resolveBooking({ id: "b-1", event: EVENT, created_at: "x", cancelled_at: null });
    await settle();

    // The stale success must not refetch or post feedback for B.
    expect(apiMock.getEvent.mock.calls.length).toBe(before);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not update the new session from the old recovery response", async () => {
    signInAsA();
    allowLoginB();
    apiMock.getEvent.mockResolvedValue(EVENT);
    apiMock.createBooking.mockRejectedValueOnce(new TypeError("network down"));
    let resolveHistory!: (body: unknown) => void;
    apiMock.myBookings.mockImplementation(
      () => new Promise((resolve) => void (resolveHistory = resolve)),
    );
    renderAccounts();

    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByText("Book one seat"));
    await screen.findByText(/may have gone through/i);
    fireEvent.click(screen.getByText("switch-b", { selector: "button" }));
    await screen.findByText("b@example.com");

    resolveHistory({ items: [], total: 0 });
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
      cancelled_at: null,
    }));
    const target = {
      id: "booking-target",
      event: EVENT,
      created_at: "2030-01-01T00:00:00Z",
      cancelled_at: null,
    };
    apiMock.myBookings.mockImplementation(async (_token: string, page: number) =>
      page === 1 ? { items: filler, total: 11 } : { items: [target], total: 11 },
    );
    renderSignedIn();

    await screen.findByText("Lockable Night");
    fireEvent.click(await screen.findByText("Book one seat"));

    await waitFor(() => expect(apiMock.myBookings).toHaveBeenCalledWith("tok-1", 2, 10));
    expect(screen.queryByText(/nothing was booked/i)).toBeNull();
    expect(screen.queryByText(/couldn't confirm/i)).toBeNull();
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
