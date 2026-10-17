/**
 * Sign-out regression (design: clear private frontend state when auth
 * changes): expiring the session must empty the rendered bookings, not
 * leave the previous user's rows on screen for a signed-out viewer.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../../lib/auth";
import { resetTokenStoreForTests } from "../../lib/token_store";
import BookingsPage from "./page";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    myBookings: vi.fn(),
    cancelBooking: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(async () => ({ id: "u-1", email: "a@example.com", role: "user" })),
  },
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return { ...mod, api: { ...mod.api, ...apiMock } };
});

const BOOKING = {
  id: "booking-1",
  event: {
    id: "event-1",
    title: "Lockable Night",
    starts_at: "2030-01-01T10:00:00Z",
    venue: "Hall",
    total_seats: 10,
    seats_left: 9,
  },
  created_at: "2030-01-01T10:00:01Z",
  cancelled_at: null,
};

function ExpiryHarness() {
  const { markSessionExpired } = useAuth();
  return (
    <>
      <BookingsPage />
      <button type="button" onClick={markSessionExpired}>
        expire
      </button>
    </>
  );
}

function LogoutHarness() {
  const { login, logout } = useAuth();
  return (
    <>
      <BookingsPage />
      <button type="button" onClick={() => void login("a@example.com", "password-123")}>
        sign-in
      </button>
      <button type="button" onClick={() => void logout()}>
        sign-out
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  resetTokenStoreForTests();
});

describe("sign-out clears bookings", () => {
  it("empties the list when the session expires", async () => {
    sessionStorage.setItem("eventbook.token", "tok-1");
    apiMock.myBookings.mockResolvedValue({ items: [BOOKING], total: 1 });
    render(
      <AuthProvider>
        <ExpiryHarness />
      </AuthProvider>,
    );
    await screen.findByText("Lockable Night");
    fireEvent.click(screen.getByText("expire", { selector: "button" }));
    await screen.findByText(
      (_, element) => element?.textContent === "Log in to see your bookings.",
    );
    expect(screen.queryByText("Lockable Night")).toBeNull();
  });
});

function SignInHarness() {
  const { login } = useAuth();
  return (
    <>
      <BookingsPage />
      <button type="button" onClick={() => void login("a@example.com", "password-123")}>
        sign-in
      </button>
    </>
  );
}

function SwitchHarness() {
  const { login } = useAuth();
  return (
    <>
      <BookingsPage />
      <button type="button" onClick={() => void login("a@example.com", "password-123")}>
        sign-in
      </button>
      <button
        type="button"
        onClick={() => void login("b@example.com", "password-123")}
      >
        switch-account
      </button>
    </>
  );
}

const USER_A = { id: "u-A", email: "a@example.com", role: "user" };
const USER_B = { id: "u-B", email: "b@example.com", role: "user" };
let currentUser = USER_A;

function bookingFor(title: string, id: string) {
  return { ...BOOKING, id, event: { ...BOOKING.event, id: `event-${id}`, title } };
}

describe("account switching scopes rows immediately", () => {
  it("drops the old account rows before the new history arrives", async () => {
    currentUser = USER_A;
    apiMock.login.mockImplementation(async () => ({
      access_token: "tok-A",
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user: currentUser,
    }));
    apiMock.me.mockImplementation(async () => currentUser);
    apiMock.myBookings.mockResolvedValue({ items: [bookingFor("Alpha Night", "a1")], total: 1 });
    render(
      <AuthProvider>
        <SwitchHarness />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("switch-account", { selector: "button" }));
    await screen.findByText("Alpha Night");

    // Second account signs in while its history fetch is still in flight.
    let resolveBeta!: (body: { items: typeof BOOKING[]; total: number }) => void;
    currentUser = USER_B;
    apiMock.myBookings.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBeta = resolve;
        }),
    );
    fireEvent.click(screen.getByText("switch-account", { selector: "button" }));
    // Old rows vanish at once instead of lingering beside the new session…
    await waitForGone("Alpha Night");
    // …and only the new account's rows render once they arrive.
    resolveBeta({ items: [bookingFor("Beta Night", "b1")], total: 1 });
    await screen.findByText("Beta Night");
    expect(screen.queryByText("Alpha Night")).toBeNull();
  });
});

async function waitForGone(text: string) {
  await screen.findByText(
    (_, element) => element?.textContent === "Log in to see your bookings." || element?.textContent === "Loading bookings…",
  );
  expect(screen.queryByText(text)).toBeNull();
}

describe("cancellation feedback survives refresh", () => {
  it("keeps the error visible after the post-failure refetch", async () => {
    const { ApiRequestError } = await import("../../lib/api");
    currentUser = USER_A;
    apiMock.login.mockImplementation(async () => ({
      access_token: "tok-A",
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user: currentUser,
    }));
    apiMock.me.mockImplementation(async () => currentUser);
    apiMock.myBookings.mockResolvedValue({ items: [BOOKING], total: 1 });
    apiMock.cancelBooking.mockRejectedValue(
      new ApiRequestError(409, "EVENT_STARTED", "This event has already started."),
    );
    render(
      <AuthProvider>
        <SignInHarness />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("sign-in", { selector: "button" }));
    await screen.findByText("Lockable Night");
    fireEvent.click(screen.getByText("Cancel booking"));
    await screen.findByText(/already started/i);
    expect(screen.getByText("Lockable Night")).not.toBeNull();
  });
});

describe("history pagination", () => {
  it("navigates through pages of bookings", async () => {
    currentUser = USER_A;
    apiMock.login.mockImplementation(async () => ({
      access_token: "tok-A",
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user: currentUser,
    }));
    apiMock.me.mockImplementation(async () => currentUser);
    apiMock.myBookings.mockImplementation(async (_token: string, page: number) => ({
      items: page === 1 ? [bookingFor("Page One", "p1")] : [bookingFor("Page Two", "p2")],
      total: 25,
    }));
    render(
      <AuthProvider>
        <SignInHarness />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("sign-in", { selector: "button" }));
    await screen.findByText("Page One");
    expect(screen.getByText(/page 1 of 3/i)).not.toBeNull();
    fireEvent.click(screen.getByText("Next"));
    await screen.findByText("Page Two");
    expect(screen.queryByText("Page One")).toBeNull();
    expect(apiMock.myBookings).toHaveBeenLastCalledWith("tok-A", 2, 10);
  });

  it("steps back when the current page empties out", async () => {
    currentUser = USER_A;
    apiMock.login.mockImplementation(async () => ({
      access_token: "tok-A",
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user: currentUser,
    }));
    apiMock.me.mockImplementation(async () => currentUser);
    apiMock.myBookings.mockImplementation(async (_token: string, page: number) => {
      if (page === 1) return { items: [bookingFor("Page One", "p1")], total: 11 };
      return { items: [bookingFor("Last One", "last")], total: 11 };
    });
    apiMock.cancelBooking.mockResolvedValue(undefined);
    render(
      <AuthProvider>
        <SignInHarness />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("sign-in", { selector: "button" }));
    await screen.findByText("Page One");
    fireEvent.click(screen.getByText("Next"));
    await screen.findByText("Last One");
    // Cancelling the only row on page 2 drops the total to one page.
    apiMock.myBookings.mockImplementation(async (_token: string, page: number) => {
      if (page === 1) return { items: [bookingFor("Page One", "p1")], total: 10 };
      return { items: [], total: 10 };
    });
    fireEvent.click(screen.getByText("Cancel booking"));
    await screen.findByText("Page One");
    expect(screen.queryByText("Last One")).toBeNull();
    expect(screen.getByText(/page 1 of 1/i)).not.toBeNull();
  });
});

describe("cancellation racing an account switch", () => {
  async function signInAs(user: { id: string; email: string; role: string }, token: string) {
    currentUser = user;
    apiMock.login.mockResolvedValue({
      access_token: token,
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user,
    });
    apiMock.me.mockResolvedValue(user);
  }

  it("ignores a completed cancellation after switching accounts", async () => {
    await signInAs(USER_A, "tok-A");
    apiMock.myBookings.mockImplementation(async (token: string) =>
      token === "tok-A"
        ? { items: [bookingFor("Alpha Night", "a1")], total: 1 }
        : { items: [bookingFor("Beta Night", "b1")], total: 1 },
    );
    let resolveCancel!: () => void;
    apiMock.cancelBooking.mockImplementation(
      () => new Promise<void>((resolve) => void (resolveCancel = resolve)),
    );
    render(
      <AuthProvider>
        <SwitchHarness />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("sign-in", { selector: "button" }));
    await screen.findByText("Alpha Night");
    fireEvent.click(screen.getByText("Cancel booking"));
    await signInAs(USER_B, "tok-B");
    fireEvent.click(screen.getByText("switch-account", { selector: "button" }));
    await screen.findByText("Beta Night");
    // A's cancellation lands after the switch: B's screen must not change.
    resolveCancel();
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.getByText("Beta Night")).not.toBeNull();
    expect(screen.queryByText("Alpha Night")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never expires the new session on the old account's 401", async () => {
    const { ApiRequestError } = await import("../../lib/api");
    await signInAs(USER_A, "tok-A");
    apiMock.myBookings.mockImplementation(async (token: string) =>
      token === "tok-A"
        ? { items: [bookingFor("Alpha Night", "a1")], total: 1 }
        : { items: [bookingFor("Beta Night", "b1")], total: 1 },
    );
    let rejectCancel!: (err: unknown) => void;
    apiMock.cancelBooking.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectCancel = reject;
        }),
    );
    render(
      <AuthProvider>
        <SwitchHarness />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("sign-in", { selector: "button" }));
    await screen.findByText("Alpha Night");
    fireEvent.click(screen.getByText("Cancel booking"));
    await signInAs(USER_B, "tok-B");
    fireEvent.click(screen.getByText("switch-account", { selector: "button" }));
    await screen.findByText("Beta Night");
    // A's stale 401 must not sign B out.
    rejectCancel(new ApiRequestError(401, "INVALID_SESSION", "Invalid or expired session."));
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.getByText("Beta Night")).not.toBeNull();
    expect(screen.queryByText(/session expired/i)).toBeNull();
    expect(screen.queryByText("Alpha Night")).toBeNull();
  });

  it("drops a stale failure message when switching mid-refetch", async () => {
    const { ApiRequestError } = await import("../../lib/api");
    await signInAs(USER_A, "tok-A");
    let resolveRefetch!: (body: { items: typeof BOOKING[]; total: number }) => void;
    let refetchStarted = false;
    apiMock.myBookings.mockImplementation(async (token: string) => {
      if (token === "tok-A" && refetchStarted) {
        return new Promise((resolve) => {
          resolveRefetch = resolve;
        });
      }
      return token === "tok-A"
        ? { items: [bookingFor("Alpha Night", "a1")], total: 1 }
        : { items: [bookingFor("Beta Night", "b1")], total: 1 };
    });
    apiMock.cancelBooking.mockRejectedValue(
      new ApiRequestError(409, "EVENT_STARTED", "This event has already started."),
    );
    render(
      <AuthProvider>
        <SwitchHarness />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("sign-in", { selector: "button" }));
    await screen.findByText("Alpha Night");
    // Hold A's refetch open, then switch: A's message must not land on B.
    refetchStarted = true;
    fireEvent.click(screen.getByText("Cancel booking"));
    await new Promise((done) => setTimeout(done, 50));
    await signInAs(USER_B, "tok-B");
    fireEvent.click(screen.getByText("switch-account", { selector: "button" }));
    await screen.findByText("Beta Night");
    resolveRefetch({ items: [bookingFor("Alpha Night", "a1")], total: 1 });
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Beta Night")).not.toBeNull();
  });
});

describe("admin booking restriction", () => {
  it("shows management guidance and never fetches history", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.me.mockResolvedValue({ id: "u-9", email: "boss@example.com", role: "admin" });
    render(
      <AuthProvider>
        <BookingsPage />
      </AuthProvider>,
    );
    await screen.findByText(/not available to administrators/i);
    expect(apiMock.myBookings).not.toHaveBeenCalled();
    expect(screen.queryByText("Cancel booking")).toBeNull();
  });
});

describe("failed server logout on the bookings page", () => {
  it("shows the revocation warning on the real page alert", async () => {
    apiMock.login.mockResolvedValue({
      access_token: "tok-1",
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user: { id: "u-1", email: "a@example.com", role: "user" },
    });
    apiMock.myBookings.mockResolvedValue({ items: [], total: 0 });
    apiMock.logout.mockRejectedValue(new Error("network down"));
    render(
      <AuthProvider>
        <LogoutHarness />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("sign-in", { selector: "button" }));
    await screen.findByText(/no bookings yet/i);
    fireEvent.click(screen.getByText("sign-out", { selector: "button" }));
    await screen.findByText(/server session may still be active/i);
  });
});

describe("start-time eligibility", () => {
  it("disables cancellation once the event starts, without a reload", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2030-01-01T09:59:55Z"));
    currentUser = USER_A;
    apiMock.login.mockResolvedValue({
      access_token: "tok-A",
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user: USER_A,
    });
    apiMock.me.mockResolvedValue(USER_A);
    apiMock.myBookings.mockResolvedValue({ items: [BOOKING], total: 1 });
    render(
      <AuthProvider>
        <SignInHarness />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByText("sign-in", { selector: "button" }));
    await screen.findByText("Lockable Night");
    const cancelButton = screen.getByRole("button", { name: "Cancel booking" });
    expect((cancelButton as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    const startedCancel = screen.getByRole("button", { name: "Cancel booking" });
    expect((startedCancel as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/already started; it can no longer be cancelled/i)).not.toBeNull();
  });
});
