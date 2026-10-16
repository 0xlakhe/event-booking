"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { ApiRequestError } from "../../lib/api";
import { friendlyAuthMessage, useAuth } from "../../lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await login(email, password);
      router.push("/");
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setFailure(friendlyAuthMessage(err.code, err.message));
      else setFailure("Login failed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main>
      <h1>Log in</h1>
      <form onSubmit={onSubmit}>
        <p>
          <label>
            Email
            <br />
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              disabled={pending}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            Password
            <br />
            <input
              type="password"
              autoComplete="current-password"
              required
              minLength={8}
              value={password}
              disabled={pending}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </p>
        {failure !== null && <p role="alert">{failure}</p>}
        <p>
          <button type="submit" disabled={pending}>
            {pending ? "Logging in…" : "Log in"}
          </button>
        </p>
      </form>
      <p className="muted">
        No account yet? <Link href="/register">Register</Link>
      </p>
    </main>
  );
}
