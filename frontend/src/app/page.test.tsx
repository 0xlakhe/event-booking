/**
 * Listing regression: a stale search response must never overwrite the
 * latest query (Review Focus: lost/stale responses).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "./page";
import Nav from "../components/nav";
import { AuthProvider, useAuth } from "../lib/auth";
import { readToken, resetTokenStoreForTests } from "../lib/token_store";
import type { EventSummary } from "../lib/api";

let queryValue = "";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn() },
}));

const { pathnameState } = vi.hoisted(() => ({
  pathnameState: { value: "/" },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(queryValue),
  usePathname: () => pathnameState.value,
}));

const { apiMock } = vi.hoisted(() => ({
  apiMock: { listEvents: vi.fn(), me: vi.fn(), logout: vi.fn(), login: vi.fn() },
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
  routerMock.push.mockClear();
  routerMock.replace.mockClear();
  apiMock.logout.mockReset();
});

describe("stale search responses", () => {
  it("renders only the latest query when responses arrive out of order", async () => {
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
    render(
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
