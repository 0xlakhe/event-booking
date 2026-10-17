/**
 * Login landing: admins go to management, everyone else browses events.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../lib/auth";
import { resetTokenStoreForTests } from "../../lib/token_store";
import LoginPage from "./page";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

const { apiMock } = vi.hoisted(() => ({
  apiMock: { login: vi.fn() },
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return { ...mod, api: { ...mod.api, ...apiMock } };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
  resetTokenStoreForTests();
});

function fillAndSubmit(email: string) {
  render(
    <AuthProvider>
      <LoginPage />
    </AuthProvider>,
  );
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "password-123" } });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
}

describe("login landing", () => {
  it("sends admins to management", async () => {
    apiMock.login.mockResolvedValue({
      access_token: "tok-admin",
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user: { id: "u-9", email: "boss@example.com", role: "admin" },
    });
    fillAndSubmit("boss@example.com");
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/admin"));
  });

  it("sends normal users to event browsing", async () => {
    apiMock.login.mockResolvedValue({
      access_token: "tok-1",
      token_type: "bearer",
      expires_at: "2030-01-01T00:00:00Z",
      user: { id: "u-1", email: "a@example.com", role: "user" },
    });
    fillAndSubmit("a@example.com");
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/"));
  });
});
