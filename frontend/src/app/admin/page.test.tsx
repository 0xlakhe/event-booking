import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminPage from "./page";
import { AuthProvider, useAuth } from "../../lib/auth";
import { resetTokenStoreForTests } from "../../lib/token_store";
import { getCachedPublicEventDetail, invalidatePublicEventDetail, loadPublicEventDetail } from "../../lib/public_event_cache";

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
    apiMock.attendees.mockImplementation(
      () => new Promise((resolve) => void (resolveAttendees = resolve)),
    );
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
    await waitFor(() => expect(apiMock.attendees).toHaveBeenCalledTimes(1));

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
