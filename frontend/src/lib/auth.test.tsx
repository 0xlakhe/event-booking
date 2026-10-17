/**
 * Logout failure-path regressions: storage breakage must not orphan the
 * server session, and revocation failure must be visible while local
 * state still clears.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth";
import { dropToken, readToken, resetTokenStoreForTests, writeToken } from "./token_store";

const { apiMock } = vi.hoisted(() => ({ apiMock: { login: vi.fn(), logout: vi.fn(), me: vi.fn() } }));

vi.mock("./api", () => {
  class ApiRequestError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiRequestError, api: apiMock };
});

const USER = { id: "u-1", email: "a@example.com", role: "user" };

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="user">{auth.user ? auth.user.email : "signed-out"}</span>
      {auth.error !== null && <p role="alert">{auth.error}</p>}
      <button type="button" onClick={() => void auth.login("a@example.com", "password-123")}>
        login
      </button>
      <button type="button" onClick={() => void auth.logout()}>
        logout
      </button>
    </div>
  );
}

function renderProbe() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

const throwingStorage = {
  getItem: () => null,
  setItem: () => {
    throw new Error("storage denied");
  },
  removeItem: () => {},
  clear: () => {},
  length: 0,
  key: () => null,
};

beforeEach(() => {
  vi.clearAllMocks();
  dropToken();
  apiMock.login.mockResolvedValue({
    access_token: "tok-123",
    token_type: "bearer",
    expires_at: "2030-01-01T00:00:00Z",
    user: USER,
  });
  apiMock.me.mockResolvedValue(USER);
});

afterEach(() => {
  cleanup();
  resetTokenStoreForTests();
  vi.unstubAllGlobals();
});

describe("storage failure keeps revocation working and stays visible", () => {
  it("signs in via memory, warns, then still revokes the server session on logout", async () => {
    vi.stubGlobal("sessionStorage", throwingStorage);
    renderProbe();

    fireEvent.click(screen.getByText("login"));
    await screen.findByText("a@example.com");
    // In-memory fallback holds the token storage refused.
    expect(readToken()).toBe("tok-123");
    // Persistence failure is reported, not silent.
    await screen.findByText(/this browser would not keep the session/i);

    apiMock.logout.mockRejectedValue(new Error("network down"));
    fireEvent.click(screen.getByText("logout"));
    // Local state clears even though the server call failed…
    await screen.findByText("signed-out");
    expect(readToken()).toBeNull();
    // …the stored-memory token was offered for revocation first…
    expect(apiMock.logout).toHaveBeenCalledWith("tok-123");
    // …and the revocation failure is visible.
    await screen.findByText(/server session may still be active/i);
  });
});

describe("server logout failure clears locally and warns", () => {
  it("clears state and shows the warning when revocation fails", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("login"));
    await screen.findByText("a@example.com");

    apiMock.logout.mockRejectedValue(new Error("network down"));
    fireEvent.click(screen.getByText("logout"));
    await screen.findByText("signed-out");
    expect(readToken()).toBeNull();
    await screen.findByText(/server session may still be active/i);
  });

  it("clears silently when revocation succeeds", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("login"));
    await screen.findByText("a@example.com");

    apiMock.logout.mockResolvedValue(undefined);
    fireEvent.click(screen.getByText("logout"));
    await screen.findByText("signed-out");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/* Operation-generation regressions: a slow restoration or logout started
 * for one account must not overwrite or clear a newer account's login. */

const USER_A = { id: "u-A", email: "a@example.com", role: "user" };
const USER_B = { id: "u-B", email: "b@example.com", role: "user" };

function RaceProbe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="who">{auth.user ? auth.user.email : "signed-out"}</span>
      {auth.expired && <span>session expired</span>}
      <button type="button" onClick={() => void auth.login("b@example.com", "password-123")}>
        login-b
      </button>
      <button type="button" onClick={() => void auth.logout()}>
        logout
      </button>
    </div>
  );
}

function renderRace() {
  return render(
    <AuthProvider>
      <RaceProbe />
    </AuthProvider>,
  );
}

async function settle() {
  await new Promise((done) => setTimeout(done, 20));
}

function loginB() {
  apiMock.login.mockResolvedValue({
    access_token: "tok-B",
    token_type: "bearer",
    expires_at: "2030-01-01T00:00:00Z",
    user: USER_B,
  });
}

describe("auth operation races", () => {
  it("a delayed restoration success cannot overwrite a newer login", async () => {
    writeToken("tok-A");
    let resolveMe!: (user: unknown) => void;
    apiMock.me.mockImplementation(() => new Promise((resolve) => void (resolveMe = resolve)));
    loginB();

    renderRace();
    // Account A's restoration is still pending; B signs in first.
    fireEvent.click(screen.getByText("login-b", { selector: "button" }));
    await screen.findByText("b@example.com");

    // A's restoration now resolves: it must not overwrite B.
    resolveMe(USER_A);
    await settle();
    expect(screen.getByText("b@example.com")).not.toBeNull();
    expect(readToken()).toBe("tok-B");
  });

  it("a delayed restoration 401 cannot clear a newer login", async () => {
    writeToken("tok-A");
    let rejectMe!: (err: unknown) => void;
    apiMock.me.mockImplementation(
      () => new Promise((_, reject) => void (rejectMe = reject)),
    );
    loginB();

    renderRace();
    fireEvent.click(screen.getByText("login-b", { selector: "button" }));
    await screen.findByText("b@example.com");

    const { ApiRequestError } = await import("./api");
    rejectMe(new ApiRequestError(401, "INVALID_SESSION", "Invalid or expired session."));
    await settle();
    expect(screen.getByText("b@example.com")).not.toBeNull();
    expect(readToken()).toBe("tok-B");
    expect(screen.queryByText("session expired")).toBeNull();
  });

  it("a logout completing after a newer login cannot clear it", async () => {
    writeToken("tok-A");
    apiMock.me.mockResolvedValue(USER_A);
    let resolveLogout!: () => void;
    apiMock.logout.mockImplementation(
      () => new Promise<void>((resolve) => void (resolveLogout = resolve)),
    );
    loginB();

    renderRace();
    await screen.findByText("a@example.com");

    fireEvent.click(screen.getByText("logout", { selector: "button" }));
    fireEvent.click(screen.getByText("login-b", { selector: "button" }));
    await screen.findByText("b@example.com");

    // A's logout finishes after B is signed in: B must stay signed in.
    resolveLogout();
    await settle();
    expect(screen.getByText("b@example.com")).not.toBeNull();
    expect(readToken()).toBe("tok-B");
  });
});
