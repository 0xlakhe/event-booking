/**
 * Token-store authority regressions: the in-memory session token wins
 * over storage, restored sessions are retained, and a dropped token
 * never comes back. Each test reloads the module for true page-load
 * semantics, since authority state is intentionally tab-lifetime state.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

function mapStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

async function freshStore() {
  vi.resetModules();
  return await import("./token_store");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("memory authority over storage", () => {
  it("a failed save keeps the new token, not the older stored one", async () => {
    const store = await freshStore();
    vi.stubGlobal("sessionStorage", {
      ...mapStorage({ "eventbook.token": "old-token" }),
      setItem: () => {
        throw new Error("storage denied");
      },
    });
    expect(store.writeToken("new-token")).toBe("memory-only");
    expect(store.readToken()).toBe("new-token");
  });

  it("a restored token survives storage becoming unreadable", async () => {
    const store = await freshStore();
    vi.stubGlobal("sessionStorage", mapStorage({ "eventbook.token": "restored-token" }));
    expect(store.readToken()).toBe("restored-token");
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("storage unreadable");
      },
      setItem: () => {
        throw new Error("storage denied");
      },
      removeItem: () => {},
    });
    expect(store.readToken()).toBe("restored-token");
  });

  it("a failed removal cannot resurrect the dropped token", async () => {
    const store = await freshStore();
    vi.stubGlobal("sessionStorage", {
      ...mapStorage({ "eventbook.token": "old-token" }),
      removeItem: () => {
        throw new Error("removal denied");
      },
    });
    store.dropToken();
    expect(store.readToken()).toBeNull();
  });

  it("a new session works after a failed drop", async () => {
    const store = await freshStore();
    vi.stubGlobal("sessionStorage", {
      ...mapStorage({ "eventbook.token": "old-token" }),
      removeItem: () => {
        throw new Error("removal denied");
      },
      setItem: () => {
        throw new Error("storage denied");
      },
    });
    store.dropToken();
    expect(store.readToken()).toBeNull();
    expect(store.writeToken("fresh-token")).toBe("memory-only");
    expect(store.readToken()).toBe("fresh-token");
  });
});
