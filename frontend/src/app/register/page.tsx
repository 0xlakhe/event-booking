"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { ApiRequestError } from "../../lib/api";
import { friendlyAuthMessage, useAuth } from "../../lib/auth";

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuth();
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
      await register(email, password);
      router.push("/login");
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setFailure(friendlyAuthMessage(err.code, err.message));
      else setFailure("Registration failed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-intro">
        <h1>Be part of it.</h1>
        <p className="muted">Create an account and make space for new experiences, one event at a time.</p>
      </div>
      <div className="auth-panel">
        <h2>Sign up</h2>
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
              Password (8–128 characters)
              <br />
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={password}
                disabled={pending}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </p>
          {failure !== null && <p role="alert">{failure}</p>}
          <p>
            <button className="button-primary" type="submit" disabled={pending}>
              {pending ? "Registering…" : "Create account"}
            </button>
          </p>
        </form>
        <p className="muted">
          Already registered? <Link href="/login">Log in</Link>
        </p>
      </div>
    </main>
  );
}
