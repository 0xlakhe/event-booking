/**
 * Role-aware navigation: public Events link for visitors and normal
 * users, hidden once restoration confirms an admin; Admin link only
 * for admins off the admin page (the self-link on /admin is hidden).
 * The link stays visible while the role is still unknown.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../lib/auth";
import { readToken, resetTokenStoreForTests } from "../lib/token_store";
import Nav from "./nav";

const { apiMock } = vi.hoisted(() => ({
  apiMock: { me: vi.fn(), logout: vi.fn() },
}));

const { pathnameState } = vi.hoisted(() => ({
  pathnameState: { value: "/" },
}));

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameState.value,
  useRouter: () => routerMock,
}));

vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: { ...mod.api, ...apiMock } };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
  pathnameState.value = "/";
  resetTokenStoreForTests();
});

function renderNav() {
  return render(
    <AuthProvider>
      <Nav />
    </AuthProvider>,
  );
}

describe("role-aware navigation", () => {
  it("shows Events without Admin to visitors", async () => {
    renderNav();
    await screen.findByText("Events");
    expect(screen.queryByText("Admin")).toBeNull();
  });

  it("keeps Events visible until restoration determines the role", async () => {
    let resolveMe!: (user: unknown) => void;
    apiMock.me.mockImplementation(() => new Promise((resolve) => void (resolveMe = resolve)));
    sessionStorage.setItem("eventbook.token", "tok-admin");
    renderNav();
    expect(screen.getByText("Events")).not.toBeNull();
    resolveMe({ id: "u-9", email: "boss@example.com", role: "admin" });
    await screen.findByText("Admin");
    expect(screen.queryByText("Events")).toBeNull();
  });

  it("shows Admin but no bookings navigation for admins", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.me.mockResolvedValue({ id: "u-9", email: "boss@example.com", role: "admin" });
    renderNav();
    await screen.findByText("Admin");
    expect(screen.queryByText("My bookings")).toBeNull();
  });

  it("hides the Admin self-link on the admin page but keeps identity and Log out", async () => {
    pathnameState.value = "/admin";
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.me.mockResolvedValue({ id: "u-9", email: "boss@example.com", role: "admin" });
    renderNav();
    await screen.findByRole("button", { name: "Log out" });
    expect(screen.queryByText("Admin")).toBeNull();
    expect(screen.getByText("boss@example.com (admin)")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Log out" })).not.toBeNull();
  });

  it("keeps the Admin link for admins off the admin page", async () => {
    pathnameState.value = "/login";
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.me.mockResolvedValue({ id: "u-9", email: "boss@example.com", role: "admin" });
    renderNav();
    await screen.findByText("Admin");
    expect(screen.getByRole("button", { name: "Log out" })).not.toBeNull();
  });

  it("shows Events and bookings navigation for normal users", async () => {
    sessionStorage.setItem("eventbook.token", "tok-1");
    apiMock.me.mockResolvedValue({ id: "u-1", email: "a@example.com", role: "user" });
    renderNav();
    await screen.findByText("Events");
    expect(screen.getByText("My bookings")).not.toBeNull();
    expect(screen.queryByText("Admin")).toBeNull();
  });

  it("keeps Log out visible for signed-in admins", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.me.mockResolvedValue({ id: "u-9", email: "boss@example.com", role: "admin" });
    renderNav();
    await screen.findByText("Admin");
    expect(screen.getByRole("button", { name: "Log out" })).not.toBeNull();
  });

  it("revokes on logout and clears local state", async () => {
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.me.mockResolvedValue({ id: "u-9", email: "boss@example.com", role: "admin" });
    apiMock.logout.mockResolvedValue(undefined);
    renderNav();
    await screen.findByText("Admin");
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await screen.findByText("Events");
    expect(apiMock.logout).toHaveBeenCalledWith("tok-admin");
    expect(screen.queryByText("Admin")).toBeNull();
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
  });

  it("clears local state but warns when revocation fails", async () => {
    sessionStorage.setItem("eventbook.token", "tok-1");
    apiMock.me.mockResolvedValue({ id: "u-1", email: "a@example.com", role: "user" });
    apiMock.logout.mockRejectedValue(new Error("network down"));
    render(
      <AuthProvider>
        <Nav />
        <WarningProbe />
      </AuthProvider>,
    );
    await screen.findByText("My bookings");
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await screen.findByText(/server session may still be active/i);
    expect(screen.queryByText("My bookings")).toBeNull();
  });
});

describe("admin logout returns to the public flow", () => {
  it("routes an admin from /admin to the public list and clears local state", async () => {
    pathnameState.value = "/admin";
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.me.mockResolvedValue({ id: "u-9", email: "boss@example.com", role: "admin" });
    apiMock.logout.mockResolvedValue(undefined);
    renderNav();
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/"));
    expect(apiMock.logout).toHaveBeenCalledWith("tok-admin");
    expect(readToken()).toBeNull();
    // Signed-out navigation replaces the admin identity and Log out.
    await screen.findByText("Events");
    expect(screen.queryByText("boss@example.com (admin)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
  });

  it("still routes to the public list and keeps the warning when revocation fails", async () => {
    pathnameState.value = "/admin/sub";
    sessionStorage.setItem("eventbook.token", "tok-admin");
    apiMock.me.mockResolvedValue({ id: "u-9", email: "boss@example.com", role: "admin" });
    apiMock.logout.mockRejectedValue(new Error("network down"));
    render(
      <AuthProvider>
        <Nav />
        <WarningProbe />
      </AuthProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/"));
    expect(readToken()).toBeNull();
    // The warning lives in shared auth state, so it survives the hop.
    await screen.findByText(/server session may still be active/i);
    await screen.findByText("Events");
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
  });

  it("keeps the visitor in place when logging out off an admin route", async () => {
    pathnameState.value = "/bookings";
    sessionStorage.setItem("eventbook.token", "tok-1");
    apiMock.me.mockResolvedValue({ id: "u-1", email: "a@example.com", role: "user" });
    apiMock.logout.mockResolvedValue(undefined);
    renderNav();
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    await screen.findByText("Events");
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});

function WarningProbe() {
  const { error, clearError } = useAuth();
  if (error === null) return null;
  return (
    <p role="alert">
      {error} <button type="button" onClick={clearError}>Dismiss</button>
    </p>
  );
}
