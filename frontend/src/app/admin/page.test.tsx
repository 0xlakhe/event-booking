import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminPage from "./page";
import { AuthProvider, useAuth } from "../../lib/auth";
import { resetTokenStoreForTests } from "../../lib/token_store";
import { getCachedPublicEventDetail, invalidatePublicEventDetail, loadPublicEventDetail } from "../../lib/public_event_cache";
import { clearAdminEventListCache } from "../../lib/admin_event_cache";

const { routerMock, navState } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn() },
  navState: { search: "" },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(navState.search),
}));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listEvents: vi.fn(),
    attendees: vi.fn(),
    getEvent: vi.fn(),
    deleteEvent: vi.fn(),
    updateEvent: vi.fn(),
    login: vi.fn(),
    me: vi.fn(async () => ({ id: "u-9", email: "boss@example.com", role: "admin" })),
  },
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...mod,
    api: { ...mod.api, me: apiMock.me, login: apiMock.login, getEvent: apiMock.getEvent },
    adminApi: { ...mod.adminApi, ...apiMock },
  };
});

function summary(title: string, starts_at: string) {
  return {
    id: `id-${title}`,
    title,
    description: `${title} description.`,
    starts_at,
    venue: "Hall",
    total_seats: 10,
    seats_left: 9,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
  navState.search = "";
  resetTokenStoreForTests();
  clearAdminEventListCache();
  vi.restoreAllMocks();
});

describe("started events are read-only", () => {
  it("shows descriptions inline without duplicate metadata or detail requests and keeps attendees reachable", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.listEvents.mockResolvedValue({
      items: [
        summary("Past Show", "2020-01-01T10:00:00Z"),
        summary("Future Show", "2030-01-01T10:00:00Z"),
      ],
      total: 2,
    });
    apiMock.attendees.mockResolvedValue({ items: [], total: 0 });
    render(
      <AuthProvider>
        <AdminPage />
      </AuthProvider>,
    );
    await screen.findByText("Past Show");
    expect(screen.queryByText(/read-only history/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Hide details|Details)$/ })).toBeNull();
    for (const title of ["Past Show", "Future Show"]) {
      const card = screen.getByText(title).closest("li");
      expect(card).not.toBeNull();
      const contents = within(card!);
      expect(contents.getByText(`${title} description.`)).not.toBeNull();
      expect(contents.getAllByText(/Hall/)).toHaveLength(1);
      expect(contents.getAllByText(/9 \/ 10 seats left/)).toHaveLength(1);
      expect(card!.querySelectorAll("[title='Nepal time (UTC+05:45)']")).toHaveLength(1);
    }
    expect(apiMock.getEvent).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Read more/i })).toBeNull();
    // Exactly one row keeps mutation controls: the future event.
    expect(screen.getAllByText("Edit")).toHaveLength(1);
    expect(screen.getAllByText("Delete")).toHaveLength(1);
    // Attendees stay reachable on the started event.
    const toggles = screen.getAllByText("Attendees");
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0]);
    await screen.findByText("Attendees (0)");
    expect(apiMock.attendees).toHaveBeenCalledTimes(1);
  });

  it("opens an accessible loading panel immediately and ignores duplicate pagination requests", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.listEvents.mockResolvedValue({
      items: [summary("Attendee Event", "2030-01-01T10:00:00Z")],
      total: 1,
    });
    let resolveFirstPage!: (body: { items: { booking_id: string; booked_at: string; user: { email: string } }[]; total: number }) => void;
    apiMock.attendees.mockImplementationOnce(
      () => new Promise((resolve) => void (resolveFirstPage = resolve)),
    );
    let resolveSecondPage!: (body: { items: { booking_id: string; booked_at: string; user: { email: string } }[]; total: number }) => void;
    apiMock.attendees.mockImplementationOnce(
      () => new Promise((resolve) => void (resolveSecondPage = resolve)),
    );
    render(<AuthProvider><AdminPage /></AuthProvider>);
    await screen.findByText("Attendee Event");

    fireEvent.click(screen.getByRole("button", { name: "Attendees" }));
    expect(screen.getByRole("status").textContent).toMatch(/loading attendees/i);
    expect(screen.getByRole("button", { name: "Hide attendees" })).toBeTruthy();
    expect(apiMock.attendees).toHaveBeenCalledTimes(1);

    resolveFirstPage({
      items: Array.from({ length: 10 }, (_, index) => ({
        booking_id: `booking-${index}`,
        booked_at: "2030-01-01T00:00:00Z",
        user: { email: `attendee-${index}@example.com` },
      })),
      total: 11,
    });
    const heading = await screen.findByRole("heading", { name: "Attendees (11)" });
    const panel = heading.closest<HTMLElement>(".attendee-panel");
    if (panel === null) throw new Error("Attendee panel is missing.");
    const next = within(panel).getByRole("button", { name: "Next" });
    fireEvent.click(next);
    expect(screen.getByRole("status").textContent).toMatch(/loading attendees/i);
    expect(screen.getByText("attendee-0@example.com")).toBeTruthy();
    expect(next.hasAttribute("disabled")).toBe(true);
    fireEvent.click(next);
    expect(apiMock.attendees).toHaveBeenCalledTimes(2);

    resolveSecondPage({
      items: [{ booking_id: "booking-10", booked_at: "2030-01-02T00:00:00Z", user: { email: "attendee-10@example.com" } }],
      total: 11,
    });
    expect(await screen.findByText("attendee-10@example.com")).toBeTruthy();
    expect(screen.queryByText("attendee-0@example.com")).toBeNull();
  });

  it("does not show old event attendees while another event is loading or after a stale response", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.listEvents.mockResolvedValue({
      items: [summary("Event A", "2030-01-01T10:00:00Z"), summary("Event B", "2030-01-02T10:00:00Z")],
      total: 2,
    });
    let resolveEventA!: (body: { items: { booking_id: string; booked_at: string; user: { email: string } }[]; total: number }) => void;
    let resolveEventB!: (body: { items: { booking_id: string; booked_at: string; user: { email: string } }[]; total: number }) => void;
    apiMock.attendees
      .mockImplementationOnce(() => new Promise((resolve) => void (resolveEventA = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => void (resolveEventB = resolve)));
    render(<AuthProvider><AdminPage /></AuthProvider>);
    await screen.findByText("Event A");

    fireEvent.click(within(screen.getByText("Event A").closest("li")!).getByRole("button", { name: "Attendees" }));
    expect(screen.getByRole("status").textContent).toMatch(/loading attendees/i);
    fireEvent.click(within(screen.getByText("Event B").closest("li")!).getByRole("button", { name: "Attendees" }));
    expect(screen.queryByText("attendee-a@example.com")).toBeNull();
    expect(apiMock.attendees).toHaveBeenCalledTimes(2);

    resolveEventA({
      items: [{ booking_id: "a", booked_at: "2030-01-01T00:00:00Z", user: { email: "attendee-a@example.com" } }],
      total: 1,
    });
    expect(screen.queryByText("attendee-a@example.com")).toBeNull();
    resolveEventB({
      items: [{ booking_id: "b", booked_at: "2030-01-02T00:00:00Z", user: { email: "attendee-b@example.com" } }],
      total: 1,
    });
    expect(await screen.findByText("attendee-b@example.com")).toBeTruthy();
    expect(screen.queryByText("attendee-a@example.com")).toBeNull();
  });

  it("keeps attendee failures retryable in the open event panel", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.listEvents.mockResolvedValue({ items: [summary("Retry Event", "2030-01-01T10:00:00Z")], total: 1 });
    apiMock.attendees
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ items: [], total: 0 });
    render(<AuthProvider><AdminPage /></AuthProvider>);
    await screen.findByText("Retry Event");

    fireEvent.click(screen.getByRole("button", { name: "Attendees" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(retry.parentElement?.textContent).toMatch(/could not load attendees/i);
    fireEvent.click(retry);
    expect(screen.getByRole("status").textContent).toMatch(/loading attendees/i);
    await screen.findByText("No active bookings.");
    expect(apiMock.attendees).toHaveBeenCalledTimes(2);
  });

  it("expands and collapses overflowing descriptions independently with accessible controls", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("event-description") ? 120 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("event-description") ? 60 : 0;
    });
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.listEvents.mockResolvedValue({
      items: [summary("Past Show", "2020-01-01T10:00:00Z"), summary("Future Show", "2030-01-01T10:00:00Z")],
      total: 2,
    });
    render(<AuthProvider><AdminPage /></AuthProvider>);
    await screen.findByText("Past Show");
    const past = within(screen.getByText("Past Show").closest("li")!);
    const future = within(screen.getByText("Future Show").closest("li")!);
    const toggle = await past.findByRole("button", { name: /Read more/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const description = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(description?.textContent).toBe("Past Show description.");
    expect(description?.classList.contains("event-description-collapsed")).toBe(true);
    fireEvent.click(toggle);
    expect(past.getByRole("button", { name: /Read less/i }).getAttribute("aria-expanded")).toBe("true");
    expect(description?.classList.contains("event-description-collapsed")).toBe(false);
    expect(future.getByRole("button", { name: /Read more/i }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(past.getByRole("button", { name: /Read less/i }));
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
    expect(description?.classList.contains("event-description-collapsed")).toBe(true);
    expect(apiMock.getEvent).not.toHaveBeenCalled();
  });

  it("remeasures a multiline description when the available width changes", async () => {
    let contentHeight = 40;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("event-description") ? contentHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("event-description") ? 60 : 0;
    });
    const description = "First paragraph.\nSecond paragraph with a long unbroken word: " + "example".repeat(60);
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.listEvents.mockResolvedValue({
      items: [{ ...summary("Responsive Show", "2030-01-01T10:00:00Z"), description }],
      total: 1,
    });
    render(<AuthProvider><AdminPage /></AuthProvider>);
    await screen.findByText("Responsive Show");
    expect(screen.queryByRole("button", { name: "Read more" })).toBeNull();
    contentHeight = 140;
    fireEvent(window, new Event("resize"));
    const toggle = await screen.findByRole("button", { name: "Read more" });
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.textContent).toBe(description);
    contentHeight = 40;
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Read more" })).toBeNull());
    expect(apiMock.getEvent).not.toHaveBeenCalled();
  });
});

describe("admin time filter", () => {
  function renderAdmin() {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    return render(
      <AuthProvider>
        <AdminPage />
      </AuthProvider>,
    );
  }

  it("defaults to Upcoming and requests the upcoming filter", async () => {
    apiMock.listEvents.mockResolvedValue({
      items: [summary("Soon", "2030-01-01T10:00:00Z")],
      total: 1,
    });
    renderAdmin();
    await screen.findByText("Soon");
    expect(screen.getByRole("button", { name: "Upcoming" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Past" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
    expect(apiMock.listEvents).toHaveBeenCalledWith("tok-admin", "", "upcoming", 1, 10);
  });

  it("requests the filter selected in the URL", async () => {
    navState.search = "time_filter=past&page=2";
    apiMock.listEvents.mockResolvedValue({
      items: [summary("Old", "2020-01-01T10:00:00Z")],
      total: 11,
    });
    renderAdmin();
    await screen.findByText("Old");
    expect(apiMock.listEvents).toHaveBeenCalledWith("tok-admin", "", "past", 2, 10);
    expect(screen.getByRole("button", { name: "Past" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("serves a previously loaded filter from cache on return without refetching", async () => {
    apiMock.listEvents
      .mockResolvedValueOnce({ items: [summary("Soon", "2030-01-01T10:00:00Z")], total: 1 })
      .mockResolvedValueOnce({ items: [summary("Old", "2020-01-01T10:00:00Z")], total: 1 });
    const view = renderAdmin();
    await screen.findByText("Soon");
    expect(apiMock.listEvents).toHaveBeenCalledTimes(1);

    navState.search = "time_filter=past";
    view.rerender(
      <AuthProvider>
        <AdminPage />
      </AuthProvider>,
    );
    await screen.findByText("Old");
    expect(apiMock.listEvents).toHaveBeenCalledTimes(2);

    navState.search = "";
    view.rerender(
      <AuthProvider>
        <AdminPage />
      </AuthProvider>,
    );
    await screen.findByText("Soon");
    expect(screen.queryByText("Old")).toBeNull();
    expect(screen.queryByText(/loading events/i)).toBeNull();
    expect(apiMock.listEvents).toHaveBeenCalledTimes(2);
  });

  it("renders a cached empty filter without refetching", async () => {
    apiMock.listEvents
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce({ items: [summary("Old", "2020-01-01T10:00:00Z")], total: 1 });
    const view = renderAdmin();
    await screen.findByText("No events found.");

    navState.search = "time_filter=past";
    view.rerender(
      <AuthProvider>
        <AdminPage />
      </AuthProvider>,
    );
    await screen.findByText("Old");

    navState.search = "";
    view.rerender(
      <AuthProvider>
        <AdminPage />
      </AuthProvider>,
    );
    await screen.findByText("No events found.");
    expect(apiMock.listEvents).toHaveBeenCalledTimes(2);
  });

  it("refetches the active filter after an edit instead of serving the cached rows", async () => {
    apiMock.getEvent.mockResolvedValue({ ...summary("Editable", "2030-01-01T10:00:00Z") });
    apiMock.updateEvent.mockResolvedValue(undefined);
    apiMock.listEvents
      .mockResolvedValueOnce({ items: [summary("Editable", "2030-01-01T10:00:00Z")], total: 1 })
      .mockResolvedValueOnce({ items: [summary("Renamed", "2030-01-01T10:00:00Z")], total: 1 });
    renderAdmin();
    await screen.findByText("Editable");

    fireEvent.click(within(screen.getByText("Editable").closest("li")!).getByRole("button", { name: "Edit" }));
    const saveButton = await screen.findByRole("button", { name: "Save changes" });
    fireEvent.submit(saveButton.closest("form")!);

    await screen.findByText("Renamed");
    expect(apiMock.listEvents).toHaveBeenCalledTimes(2);
  });

  it("resets to page one and preserves search when the filter changes", async () => {
    navState.search = "q=gala&time_filter=upcoming&page=3";
    apiMock.listEvents.mockResolvedValue({
      items: [summary("Gala", "2030-01-01T10:00:00Z")],
      total: 25,
    });
    renderAdmin();
    await screen.findByText("Gala");
    fireEvent.click(screen.getByRole("button", { name: "Past" }));
    expect(routerMock.push).toHaveBeenCalledWith("/admin?q=gala&time_filter=past");
  });

  it("keeps the selected filter when paging", async () => {
    navState.search = "time_filter=past";
    apiMock.listEvents.mockResolvedValue({
      items: [summary("Old", "2020-01-01T10:00:00Z")],
      total: 25,
    });
    renderAdmin();
    await screen.findByText("Old");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(routerMock.push).toHaveBeenCalledWith("/admin?time_filter=past&page=2");
  });

  it("keeps the selected filter when searching", async () => {
    navState.search = "time_filter=all";
    apiMock.listEvents.mockResolvedValue({
      items: [summary("Anything", "2030-01-01T10:00:00Z")],
      total: 1,
    });
    renderAdmin();
    await screen.findByText("Anything");
    fireEvent.change(screen.getByLabelText("Search events by title"), { target: { value: "gala" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(routerMock.push).toHaveBeenCalledWith("/admin?q=gala&time_filter=all");
  });

  it("drops the redundant Back to events link", async () => {
    apiMock.listEvents.mockResolvedValue({ items: [], total: 0 });
    renderAdmin();
    await screen.findByText("No events found.");
    expect(screen.queryByRole("link", { name: "Back to events" })).toBeNull();
    expect(screen.queryByText("Back to events")).toBeNull();
  });

  it("omits the default Upcoming filter from the URL", async () => {
    apiMock.listEvents.mockResolvedValue({
      items: [summary("Soon", "2030-01-01T10:00:00Z")],
      total: 25,
    });
    renderAdmin();
    await screen.findByText("Soon");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(routerMock.push).toHaveBeenCalledWith("/admin?page=2");
    fireEvent.change(screen.getByLabelText("Search events by title"), { target: { value: "gala" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(routerMock.push).toHaveBeenLastCalledWith("/admin?q=gala");
  });
});

const ADMIN_A = { id: "admin-a", email: "a@example.com", role: "admin" };
const ADMIN_B = { id: "admin-b", email: "b@example.com", role: "admin" };

function AdminLoginHarness() {
  const { login } = useAuth();
  return (
    <button type="button" onClick={() => void login("b@example.com", "password-123")}>
      switch-admin
    </button>
  );
}

describe("admin list refresh context", () => {
  it("invalidates warmed public details after an admin edit", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    const item = summary("Edited Show", "2030-01-01T10:00:00Z");
    const detail = { ...item, description: "Edited Show description." };
    invalidatePublicEventDetail(item.id);
    apiMock.getEvent.mockResolvedValue(detail);
    apiMock.updateEvent.mockResolvedValue(undefined);
    apiMock.listEvents.mockResolvedValue({ items: [detail], total: 1 });
    await loadPublicEventDetail(item.id);
    expect(getCachedPublicEventDetail(item.id)).not.toBeNull();
    render(
      <AuthProvider>
        <AdminPage />
      </AuthProvider>,
    );
    await screen.findByText(item.title);
    fireEvent.click(within(screen.getByText(item.title).closest("li")!).getByRole("button", { name: "Edit" }));
    const saveButton = await screen.findByRole("button", { name: "Save changes" });
    fireEvent.submit(saveButton.closest("form")!);

    await waitFor(() => expect(apiMock.updateEvent).toHaveBeenCalledTimes(1));
    expect(getCachedPublicEventDetail(item.id)).toBeNull();
  });

  it("keeps same-query rows visible during mutation refresh and updates them afterward", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.me.mockResolvedValue(ADMIN_A);
    apiMock.listEvents.mockResolvedValueOnce({
      items: [summary("Current Show", "2030-01-01T10:00:00Z")],
      total: 1,
    });
    apiMock.deleteEvent.mockResolvedValue(undefined);
    let resolveRefresh!: (body: { items: ReturnType<typeof summary>[]; total: number }) => void;
    apiMock.listEvents.mockImplementationOnce(
      () => new Promise((resolve) => void (resolveRefresh = resolve)),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <AuthProvider>
        <AdminPage />
      </AuthProvider>,
    );
    await screen.findByText("Current Show");

    fireEvent.click(within(screen.getByText("Current Show").closest("li")!).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(apiMock.listEvents).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole("status")).textContent).toMatch(/updating events/i);
    expect(screen.getByText("Current Show")).not.toBeNull();
    expect(screen.getByText(/updating availability/i)).not.toBeNull();
    resolveRefresh({ items: [summary("Updated Show", "2030-01-01T10:00:00Z")], total: 1 });
    await screen.findByText("Updated Show");
    expect(screen.queryByText("Current Show")).toBeNull();
  });

  it("does not show prior-query admin rows as the selected results", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.listEvents.mockResolvedValueOnce({
      items: [summary("Old Filter", "2030-01-01T10:00:00Z")],
      total: 1,
    });
    let resolveNext!: (body: { items: ReturnType<typeof summary>[]; total: number }) => void;
    apiMock.listEvents.mockImplementationOnce(
      () => new Promise((resolve) => void (resolveNext = resolve)),
    );
    const view = render(
      <AuthProvider>
        <AdminPage />
      </AuthProvider>,
    );
    await screen.findByText("Old Filter");

    navState.search = "q=new";
    view.rerender(
      <AuthProvider>
        <AdminPage />
      </AuthProvider>,
    );

    expect(screen.queryByText("Old Filter")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/loading events/i);
    resolveNext({ items: [summary("New Filter", "2030-01-01T10:00:00Z")], total: 1 });
    await screen.findByText("New Filter");
  });

  it("hides previous-admin rows immediately when switching admin accounts", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin-a");
    apiMock.me.mockResolvedValue(ADMIN_A);
    apiMock.login.mockResolvedValue({
      access_token: "tok-admin-b",
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user: ADMIN_B,
    });
    let resolveAttendees!: (body: { items: { booking_id: string; booked_at: string; user: { email: string } }[]; total: number }) => void;
    apiMock.attendees
      .mockResolvedValueOnce({
        items: [{ booking_id: "loaded-a", booked_at: "2030-01-01T00:00:00Z", user: { email: "private-a@example.com" } }],
        total: 1,
      })
      .mockImplementationOnce(() => new Promise((resolve) => void (resolveAttendees = resolve)));
    apiMock.listEvents.mockResolvedValueOnce({
      items: [summary("Admin A Event", "2030-01-01T10:00:00Z")],
      total: 1,
    });
    let resolveNext!: (body: { items: ReturnType<typeof summary>[]; total: number }) => void;
    apiMock.listEvents.mockImplementationOnce(
      () => new Promise((resolve) => void (resolveNext = resolve)),
    );
    render(
      <AuthProvider>
        <AdminPage />
        <AdminLoginHarness />
      </AuthProvider>,
    );
    await screen.findByText("Admin A Event");
    fireEvent.click(screen.getByRole("button", { name: "Attendees" }));
    await screen.findByText("private-a@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Hide attendees" }));
    fireEvent.click(screen.getByRole("button", { name: "Attendees" }));
    await waitFor(() => expect(apiMock.attendees).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByText("switch-admin", { selector: "button" }));
    resolveAttendees({
      items: [{ booking_id: "booking-a", booked_at: "2030-01-01T00:00:00Z", user: { email: "private-a@example.com" } }],
      total: 1,
    });

    await waitFor(() => expect(apiMock.listEvents).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Admin A Event")).toBeNull();
    expect(screen.queryByText("private-a@example.com")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/loading events/i);
    resolveNext({ items: [summary("Admin B Event", "2030-01-01T10:00:00Z")], total: 1 });
    await screen.findByText("Admin B Event");
  });
});
