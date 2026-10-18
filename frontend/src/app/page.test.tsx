/**
 * Listing regression: a stale search response must never overwrite the
 * latest query (Review Focus: lost/stale responses).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "./page";
import Nav from "../components/nav";
import { AuthProvider, useAuth } from "../lib/auth";
import { readToken, resetTokenStoreForTests } from "../lib/token_store";
import type { EventDetail, EventSummary } from "../lib/api";
import DetailPage from "./events/[id]/page";
import { clearEventListOrigin, clearPublicEventListCache, getEventListOriginForEvent, invalidatePublicEventLists, rememberEventListOrigin } from "../lib/event_list_navigation";
import { getCachedPublicEventDetail } from "../lib/public_event_cache";

let queryValue = "";

const { routerMock, routeState } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  routeState: { id: "id-Warm Detail" },
}));

const { pathnameState } = vi.hoisted(() => ({
  pathnameState: { value: "/" },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(queryValue),
  usePathname: () => pathnameState.value,
  useParams: () => routeState,
}));

const { apiMock } = vi.hoisted(() => ({
  apiMock: { listEvents: vi.fn(), getEvent: vi.fn(), myBookings: vi.fn(), me: vi.fn(), logout: vi.fn(), login: vi.fn() },
}));

vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: { ...mod.api, ...apiMock } };
});

function event(title: string): EventSummary {
  return {
    id: `id-${title}`,
    title,
    starts_at: "2030-01-01T10:00:00Z",
    venue: "Hall",
    total_seats: 10,
    seats_left: 9,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  resetTokenStoreForTests();
  queryValue = "";
  pathnameState.value = "/";
  routeState.id = "id-Warm Detail";
  window.history.replaceState({}, "", "/");
  clearEventListOrigin();
  clearPublicEventListCache();
  routerMock.push.mockClear();
  routerMock.replace.mockClear();
  routerMock.back.mockClear();
  apiMock.logout.mockReset();
  apiMock.getEvent.mockReset();
  apiMock.myBookings.mockReset();
  apiMock.me.mockReset();
  vi.restoreAllMocks();
});

describe("stale search responses", () => {
  it("restores a fresh exact query and page without reloading it", async () => {
    apiMock.listEvents.mockReset();
    apiMock.listEvents
      .mockResolvedValueOnce({ items: [event("Ceramics Page Two")], total: 21 })
      .mockResolvedValueOnce({ items: [event("Music Page One")], total: 1 });
    queryValue = "q=ceramics&page=2";
    const view = render(<AuthProvider><Home /></AuthProvider>);
    await screen.findByText("Ceramics Page Two");

    queryValue = "q=music&page=1";
    view.rerender(<AuthProvider><Home /></AuthProvider>);
    await screen.findByText("Music Page One");

    queryValue = "q=ceramics&page=2";
    view.rerender(<AuthProvider><Home /></AuthProvider>);
    expect(apiMock.listEvents).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Ceramics Page Two")).not.toBeNull();
    expect(screen.queryByText("Music Page One")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not present previous-query events as the new results", async () => {
    apiMock.listEvents.mockReset();
    apiMock.listEvents.mockResolvedValueOnce({ items: [event("Old Query")], total: 1 });
    let resolveNext!: (body: { items: EventSummary[]; total: number }) => void;
    apiMock.listEvents.mockImplementationOnce(
      () => new Promise((resolve) => void (resolveNext = resolve)),
    );
    const view = render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    await screen.findByText("Old Query");

    queryValue = "q=new";
    view.rerender(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );

    expect(screen.queryByText("Old Query")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/loading events/i);
    resolveNext({ items: [event("New Query")], total: 1 });
    await screen.findByText("New Query");
  });

  it("renders only the latest query when responses arrive out of order", async () => {
    apiMock.listEvents.mockClear();
    const resolvers: Array<(body: { items: EventSummary[]; total: number }) => void> = [];
    apiMock.listEvents.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    expect(apiMock.listEvents).toHaveBeenCalledTimes(1);

    queryValue = "q=first";
    view.rerender(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    queryValue = "q=second";
    view.rerender(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    expect(apiMock.listEvents).toHaveBeenCalledTimes(3);

    // Resolve newest first, then let the stale ones land late.
    resolvers[2]({ items: [event("Second")], total: 1 });
    await screen.findByText("Second");
    resolvers[0]({ items: [event("StaleZero")], total: 1 });
    resolvers[1]({ items: [event("StaleFirst")], total: 1 });
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByText("StaleZero")).toBeNull();
    expect(screen.queryByText("StaleFirst")).toBeNull();
    expect(screen.getByText("Second")).not.toBeNull();
  });

  it("shows the empty state when no events match", async () => {
    apiMock.listEvents.mockResolvedValue({ items: [], total: 0 });
    const restoredListing = render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    await screen.findByText(/no events found/i);
  });
});

describe("event discovery", () => {
  it("links the hero to the visible listing and gives each event one detail action with its date", async () => {
    apiMock.listEvents.mockResolvedValue({ items: [event("Evening workshop")], total: 1 });
    render(<AuthProvider><Home /></AuthProvider>);
    await screen.findByText("Evening workshop");
    expect(screen.getByRole("link", { name: "Browse events" }).getAttribute("href")).toBe("#events");
    const detailLinks = screen.getAllByRole("link").filter((link) => link.getAttribute("href") === "/events/id-Evening workshop");
    expect(detailLinks).toHaveLength(1);
    expect(detailLinks[0].textContent).toBe("View event");
    expect(screen.getByRole("link", { name: "View event: Evening workshop" })).toBe(detailLinks[0]);
    expect(screen.getByText("01 Jan 2030, 15:45").closest("time")?.getAttribute("dateTime")).toBe("2030-01-01T10:00:00Z");
  });
});

describe("admin navigation", () => {
  it("redirects admins to management only after restoration", async () => {
    routerMock.replace.mockClear();
    apiMock.listEvents.mockClear();
    sessionStorage.setItem("eventbook.token", "tok-admin");
    let resolveMe!: (user: unknown) => void;
    apiMock.me.mockImplementation(() => new Promise((resolve) => void (resolveMe = resolve)));
    render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    // Restoration pending: neither redirect nor listing fetch may run.
    await new Promise((done) => setTimeout(done, 20));
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(apiMock.listEvents).not.toHaveBeenCalled();
    resolveMe({ id: "u-9", email: "boss@example.com", role: "admin" });
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/admin"));
    expect(apiMock.listEvents).not.toHaveBeenCalled();
  });

  it("never redirects visitors or normal users", async () => {
    routerMock.replace.mockClear();
    apiMock.listEvents.mockResolvedValue({ items: [], total: 0 });
    render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    await screen.findByText(/no events found/i);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("loads the list for signed-in normal users without redirecting", async () => {
    routerMock.replace.mockClear();
    sessionStorage.setItem("eventbook.token", "tok-1");
    apiMock.me.mockResolvedValue({ id: "u-1", email: "a@example.com", role: "user" });
    apiMock.listEvents.mockResolvedValue({ items: [], total: 0 });
    render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    await screen.findByText(/no events found/i);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});

describe("admin logout lands on the public list", () => {
  function adminSession() {
    pathnameState.value = "/admin";
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.me.mockResolvedValue({ id: "u-9", email: "boss@example.com", role: "admin" });
    apiMock.listEvents.mockResolvedValue({ items: [event("Public Show")], total: 1 });
  }

  it("shows the public list and signed-out navigation after logging out of /admin", async () => {
    adminSession();
    apiMock.logout.mockResolvedValue(undefined);
    render(
      <AuthProvider>
        <Nav />
        <Home />
      </AuthProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/"));
    // The destination renders the public list with signed-out navigation.
    await screen.findByText("Public Show");
    expect(screen.getByText("Events")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
    // A deliberate logout clears the expired flag: no spurious expiry alert.
    expect(screen.queryByText(/session expired/i)).toBeNull();
  });

  it("keeps the revocation warning visible on the public list when logout fails", async () => {
    adminSession();
    apiMock.logout.mockRejectedValue(new Error("network down"));
    render(
      <AuthProvider>
        <Nav />
        <Home />
      </AuthProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/"));
    await screen.findByText("Public Show");
    // Shared auth state persists across the client navigation, so the
    // failed-revocation warning is still shown on the destination page.
    await screen.findByText(/server session may still be active/i);
    // Failed revocation is not an expiry: the expiry alert stays absent.
    expect(screen.queryByText(/session expired/i)).toBeNull();
  });
});

/* Readiness race regression: a successful current login must finalize
 * authentication readiness even while an older session's restoration
 * request is still pending. */

const USER_A = { id: "u-A", email: "a@example.com", role: "user" };
const USER_B = { id: "u-B", email: "b@example.com", role: "user" };

function LoginHarness() {
  const { user, login } = useAuth();
  return (
    <>
      <span data-testid="who">{user ? user.email : "signed-out"}</span>
      <button type="button" onClick={() => void login("b@example.com", "password-123")}>
        login-b
      </button>
    </>
  );
}

describe("login finalizes authentication readiness", () => {
  it("loads the listing when a current login completes during a pending restoration", async () => {
    apiMock.listEvents.mockClear();
    apiMock.me.mockClear();
    apiMock.login.mockClear();
    sessionStorage.setItem("eventbook.token", "tok-A");
    let resolveMe!: (user: unknown) => void;
    apiMock.me.mockImplementation(() => new Promise((resolve) => void (resolveMe = resolve)));
    apiMock.login.mockResolvedValue({
      access_token: "tok-B",
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user: USER_B,
    });
    apiMock.listEvents.mockResolvedValue({ items: [event("Beta Show")], total: 1 });
    render(
      <AuthProvider>
        <Home />
        <LoginHarness />
      </AuthProvider>,
    );

    // Account A's restoration is held open: authentication is not ready yet.
    await new Promise((done) => setTimeout(done, 20));
    expect(apiMock.listEvents).not.toHaveBeenCalled();

    // Account B logs in while A's restoration is still pending.
    fireEvent.click(screen.getByText("login-b", { selector: "button" }));
    await screen.findByText("b@example.com");

    // The current login finalizes readiness, so the listing loads
    // immediately instead of waiting for A's obsolete restoration.
    await screen.findByText("Beta Show");
    expect(apiMock.listEvents).toHaveBeenCalledTimes(1);

    // A's stale restoration now settles: B's session is unchanged.
    resolveMe(USER_A);
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.getByText("b@example.com")).not.toBeNull();
    expect(screen.getByText("Beta Show")).not.toBeNull();
    expect(readToken()).toBe("tok-B");
    expect(apiMock.listEvents).toHaveBeenCalledTimes(1);
  });
});

describe("listing background refresh", () => {
  it("keeps a fresh public list ready across a session change without refetching", async () => {
    apiMock.listEvents.mockReset();
    apiMock.listEvents.mockResolvedValueOnce({ items: [event("Current Show")], total: 1 });
    apiMock.login.mockResolvedValue({
      access_token: "tok-B",
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user: USER_B,
    });
    render(
      <AuthProvider>
        <Home />
        <LoginHarness />
      </AuthProvider>,
    );
    await screen.findByText("Current Show");

    fireEvent.click(screen.getByText("login-b", { selector: "button" }));

    await screen.findByText("b@example.com");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Current Show")).not.toBeNull();
    expect(apiMock.listEvents).toHaveBeenCalledTimes(1);
  });
});

describe("fresh list cache expiry", () => {
  it("reloads an expired exact-query result instead of presenting it as fresh", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    apiMock.listEvents.mockResolvedValueOnce({ items: [event("Recently Listed")], total: 1 });
    const firstVisit = render(<AuthProvider><Home /></AuthProvider>);
    await screen.findByText("Recently Listed");
    firstVisit.unmount();

    now += 30_001;
    apiMock.listEvents.mockResolvedValueOnce({ items: [event("Reloaded Listing")], total: 1 });
    render(<AuthProvider><Home /></AuthProvider>);

    expect(screen.getByRole("status").textContent).toMatch(/loading events/i);
    expect(screen.queryByText("Recently Listed")).toBeNull();
    await screen.findByText("Reloaded Listing");
    expect(apiMock.listEvents).toHaveBeenCalledTimes(2);
  });
});

describe("event intent prefetch and list restoration", () => {
  it("keeps the list visible until the clicked event is ready, then navigates once", async () => {
    const item = event("Delayed Detail");
    const detail: EventDetail = { ...item, description: "Ready detail" };
    Object.defineProperty(window, "scrollY", { configurable: true, value: 140 });
    apiMock.listEvents.mockResolvedValue({ items: [item], total: 1 });
    let resolveDetail!: (value: EventDetail) => void;
    apiMock.getEvent.mockImplementation(
      () => new Promise((resolve) => void (resolveDetail = resolve)),
    );
    const listing = render(<AuthProvider><Home /></AuthProvider>);
    const link = await screen.findByRole("link", { name: "View event: Delayed Detail" });

    fireEvent.click(link);
    expect(screen.getByText("Delayed Detail")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/opening event/i);
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(getEventListOriginForEvent(item.id)).toBeNull();
    fireEvent.click(link);
    expect(apiMock.getEvent).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 440 });

    await act(async () => resolveDetail(detail));
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith("/events/id-Delayed Detail");
    expect(getEventListOriginForEvent(item.id)?.href).toBe("/");
    expect(getEventListOriginForEvent(item.id)?.scrollY).toBe(440);
    listing.unmount();
  });

  it("does not navigate to a delayed event after the listing context changes", async () => {
    const item = event("Stale Destination");
    apiMock.listEvents.mockResolvedValue({ items: [item], total: 1 });
    let resolveDetail!: (value: EventDetail) => void;
    apiMock.getEvent.mockImplementation(
      () => new Promise((resolve) => void (resolveDetail = resolve)),
    );
    const listing = render(<AuthProvider><Home /></AuthProvider>);
    fireEvent.click(await screen.findByRole("link", { name: "View event: Stale Destination" }));

    queryValue = "q=changed";
    listing.rerender(<AuthProvider><Home /></AuthProvider>);
    await act(async () => resolveDetail({ ...item, description: "Stale response" }));

    expect(routerMock.push).not.toHaveBeenCalled();
    expect(getEventListOriginForEvent(item.id)).toBeNull();
  });

  it("does not override an in-page destination with a delayed event navigation", async () => {
    const item = event("Hash Race Destination");
    apiMock.listEvents.mockResolvedValue({ items: [item], total: 1 });
    let resolveDetail!: (value: EventDetail) => void;
    apiMock.getEvent.mockImplementation(
      () => new Promise((resolve) => void (resolveDetail = resolve)),
    );
    render(<AuthProvider><Home /></AuthProvider>);
    fireEvent.click(await screen.findByRole("link", { name: "View event: Hash Race Destination" }));
    fireEvent.click(screen.getByRole("link", { name: "Browse events" }));

    await act(async () => resolveDetail({ ...item, description: "Stale response" }));

    expect(routerMock.push).not.toHaveBeenCalled();
    expect(getEventListOriginForEvent(item.id)).toBeNull();
  });

  it("keeps the list and offers retry when the clicked event request fails", async () => {
    const item = event("Retry Destination");
    apiMock.listEvents.mockResolvedValue({ items: [item], total: 1 });
    apiMock.getEvent.mockRejectedValueOnce(new TypeError("offline"));
    const listing = render(<AuthProvider><Home /></AuthProvider>);
    fireEvent.click(await screen.findByRole("link", { name: "View event: Retry Destination" }));

    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(screen.getByText("Retry Destination")).not.toBeNull();
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(getEventListOriginForEvent(item.id)).toBeNull();

    let resolveDetail!: (value: EventDetail) => void;
    apiMock.getEvent.mockImplementationOnce(
      () => new Promise((resolve) => void (resolveDetail = resolve)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry opening Retry Destination" }));
    await act(async () => resolveDetail({ ...item, description: "Retried detail" }));
    expect(routerMock.push).toHaveBeenCalledWith("/events/id-Retry Destination");
    listing.unmount();
  });

  it("preserves modified-click anchor behavior without starting navigation loading", async () => {
    const item = event("New Tab Destination");
    apiMock.listEvents.mockResolvedValue({ items: [item], total: 1 });
    const listing = render(<AuthProvider><Home /></AuthProvider>);
    const link = await screen.findByRole("link", { name: "View event: New Tab Destination" });

    const suppressBrowserNavigation = (click: Event) => click.preventDefault();
    document.addEventListener("click", suppressBrowserNavigation);
    fireEvent.click(link, { ctrlKey: true });
    document.removeEventListener("click", suppressBrowserNavigation);

    expect(apiMock.getEvent).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(link.getAttribute("href")).toBe("/events/id-New Tab Destination");
    expect(getEventListOriginForEvent(item.id)).toBeNull();
    expect(link.tagName).toBe("A");
    listing.unmount();
  });

  it("warms public detail on focus and reuses the fresh completed prefetch", async () => {
    sessionStorage.setItem("eventbook.token", "tok-user");
    apiMock.me.mockResolvedValue({ id: "u-1", email: "user@example.com", role: "user" });
    apiMock.myBookings.mockResolvedValue({ items: [], total: 0 });
    const warmDetail: EventDetail = {
      ...event("Warm Detail"),
      id: "id-Warm Detail",
      description: "A warm public description.",
    };
    apiMock.listEvents.mockReset().mockResolvedValue({ items: [event("Warm Detail")], total: 1 });
    let resolveWarm!: (detail: EventDetail) => void;
    apiMock.getEvent
      .mockImplementationOnce(() => new Promise((resolve) => void (resolveWarm = resolve)));
    const listing = render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    const link = await screen.findByRole("link", { name: "View event: Warm Detail" });
    fireEvent.focus(link);
    fireEvent.mouseEnter(link);
    expect(apiMock.getEvent).toHaveBeenCalledTimes(1);
    await act(async () => resolveWarm(warmDetail));
    listing.unmount();

    routeState.id = warmDetail.id;
    pathnameState.value = `/events/${warmDetail.id}`;
    window.history.pushState({}, "", pathnameState.value);
    const detailView = render(
      <AuthProvider>
        <DetailPage />
      </AuthProvider>,
    );

    expect(screen.getByText("A warm public description.")).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/updating availability/i)).toBeNull();
    expect(apiMock.getEvent).toHaveBeenCalledTimes(1);
    detailView.unmount();
  });

  it("starts a fresh detail request when navigation beats the intent prefetch", async () => {
    sessionStorage.setItem("eventbook.token", "tok-user");
    apiMock.me.mockResolvedValue({ id: "u-1", email: "user@example.com", role: "user" });
    apiMock.myBookings.mockResolvedValue({ items: [], total: 0 });
    const item = event("Pending Prefetch");
    const warmDetail: EventDetail = { ...item, description: "Potentially stale", seats_left: 0 };
    const currentDetail: EventDetail = { ...item, description: "Fresh detail", seats_left: 5 };
    apiMock.listEvents.mockReset().mockResolvedValue({ items: [item], total: 1 });
    let resolvePrefetch!: (detail: EventDetail) => void;
    let resolveCurrent!: (detail: EventDetail) => void;
    apiMock.getEvent
      .mockImplementationOnce(() => new Promise((resolve) => void (resolvePrefetch = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => void (resolveCurrent = resolve)));
    const listing = render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    fireEvent.focus(await screen.findByRole("link", { name: "View event: Pending Prefetch" }));
    expect(apiMock.getEvent).toHaveBeenCalledTimes(1);
    listing.unmount();

    routeState.id = item.id;
    pathnameState.value = `/events/${item.id}`;
    window.history.pushState({}, "", pathnameState.value);
    const detailView = render(
      <AuthProvider>
        <DetailPage />
      </AuthProvider>,
    );
    await waitFor(() => expect(apiMock.getEvent).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status").textContent).toMatch(/loading event details/i);
    expect(screen.queryByRole("button", { name: /book/i })).toBeNull();

    await act(async () => resolveCurrent(currentDetail));
    expect(await screen.findByText("Fresh detail")).not.toBeNull();
    expect(screen.getByText("5 / 10 seats left")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Book one seat" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => resolvePrefetch(warmDetail));
    expect(screen.getByText("5 / 10 seats left")).not.toBeNull();
    expect(getCachedPublicEventDetail(item.id)?.seats_left).toBe(5);
    detailView.unmount();
  });

  it("prefetches at most three cards at once and ignores prefetch failures", async () => {
    const events = [event("Intent One"), event("Intent Two"), event("Intent Three"), event("Intent Four")];
    apiMock.listEvents.mockReset().mockResolvedValue({ items: events, total: events.length });
    const pending: Array<(detail: EventDetail) => void> = [];
    apiMock.getEvent.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    const links = await Promise.all(events.map((item) => screen.findByRole("link", { name: `View event: ${item.title}` })));
    for (const link of links) fireEvent.focus(link);
    expect(apiMock.getEvent).toHaveBeenCalledTimes(3);
    await act(async () => {
      for (let index = 0; index < pending.length; index += 1) {
        pending[index]({
          ...events[index],
          description: `${events[index].title} description`,
        });
      }
    });

    apiMock.getEvent.mockRejectedValueOnce(new TypeError("offline"));
    fireEvent.mouseEnter(links[3]);
    await waitFor(() => expect(apiMock.getEvent).toHaveBeenCalledTimes(4));
    expect(screen.getByText("Intent Four")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("restores the exact search/page origin scroll only after its rows load", async () => {
    queryValue = "q=ceramics&page=2";
    window.history.replaceState({}, "", "/?q=ceramics&page=2");
    Object.defineProperty(window, "scrollY", { configurable: true, value: 612 });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    apiMock.listEvents.mockReset().mockResolvedValueOnce({ items: [event("Page Two")], total: 21 });
    apiMock.getEvent.mockResolvedValue({ ...event("Page Two"), id: "id-Page Two", description: "Detail" });
    const listing = render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    const eventLink = await screen.findByRole("link", { name: "View event: Page Two" });
    fireEvent.click(eventLink);
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/events/id-Page Two"));
    listing.unmount();

    routeState.id = "id-Page Two";
    pathnameState.value = "/events/id-Page Two";
    window.history.pushState({}, "", pathnameState.value);
    apiMock.getEvent.mockResolvedValue({ ...event("Page Two"), id: "id-Page Two", description: "Detail" });
    const detailView = render(
      <AuthProvider>
        <DetailPage />
      </AuthProvider>,
    );
    await screen.findByText("Detail");
    const backLink = screen.getByRole("link", { name: "Back to events" });
    expect(backLink.getAttribute("href")).toBe("/?q=ceramics&page=2");
    routerMock.push.mockClear();
    fireEvent.click(backLink);
    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(routerMock.push).not.toHaveBeenCalled();
    detailView.unmount();

    window.history.pushState({}, "", "/?q=ceramics&page=2");
    queryValue = "q=ceramics&page=2";
    pathnameState.value = "/";
    apiMock.listEvents.mockClear();
    const restoredListing = render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    expect(screen.getByText("Page Two")).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(apiMock.listEvents).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith(0, 612);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/page 2 of/i)).not.toBeNull();
    restoredListing.unmount();

    window.history.pushState({}, "", "/events/unrelated");
    pathnameState.value = "/events/unrelated";
    window.history.pushState({}, "", "/?q=ceramics&page=2");
    pathnameState.value = "/";
    render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    expect(screen.getByText("Page Two")).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(apiMock.listEvents).not.toHaveBeenCalled();
  });

  it("restores the origin scroll after an invalidation once the refetched rows load", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    queryValue = "q=ceramics&page=2";
    window.history.replaceState({}, "", "/?q=ceramics&page=2");
    rememberEventListOrigin("id-Page Two", "/?q=ceramics&page=2", 612, {
      items: [event("Stale Row")],
      total: 1,
    });
    invalidatePublicEventLists();
    let resolveList!: (body: { items: EventSummary[]; total: number }) => void;
    apiMock.listEvents.mockReset().mockImplementationOnce(
      () => new Promise((resolve) => void (resolveList = resolve)),
    );

    render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );

    // An invalidated snapshot is never painted, so nothing may be restored
    // while the list that the visitor actually returns to is still missing.
    expect(screen.queryByText("Stale Row")).toBeNull();
    await waitFor(() => expect(apiMock.listEvents).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toMatch(/loading events/i);
    expect(scrollTo).not.toHaveBeenCalled();

    await act(async () => resolveList({ items: [event("Page Two")], total: 1 }));

    // Once the fresh rows are committed the remembered position is restored.
    expect(screen.getByText("Page Two")).not.toBeNull();
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 612));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("does not present invalidated return data as fresh when loading fails", async () => {
    const snapshotRow = event("Snapshot After Failure");
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    queryValue = "q=ceramics&page=2";
    window.history.replaceState({}, "", "/?q=ceramics&page=2");
    rememberEventListOrigin("failure-event", "/?q=ceramics&page=2", 300, {
      items: [snapshotRow],
      total: 21,
    });
    invalidatePublicEventLists();
    let rejectList!: (error: Error) => void;
    apiMock.listEvents.mockImplementationOnce(
      () => new Promise((_, reject) => void (rejectList = reject)),
    );
    render(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );

    expect(screen.queryByText("Snapshot After Failure")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/loading events/i);
    await act(async () => rejectList(new TypeError("offline")));

    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(screen.getByRole("alert")).not.toBeNull();
    expect(screen.queryByText("9 seats left")).toBeNull();
  });

  it("uses the public list as a safe Back fallback for direct detail entry", async () => {
    routeState.id = "standalone-event";
    pathnameState.value = "/events/standalone-event";
    apiMock.getEvent.mockResolvedValue({ ...event("Standalone"), id: routeState.id, description: "Direct entry" });
    render(
      <AuthProvider>
        <DetailPage />
      </AuthProvider>,
    );
    await screen.findByText("Direct entry");
    expect(screen.getByRole("link", { name: "Back to events" }).getAttribute("href")).toBe("/");
  });
});
