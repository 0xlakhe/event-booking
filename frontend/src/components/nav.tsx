"use client";

/* Role-aware navigation. Display-only: every protected route and API
   enforces its own backend permission checks. */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "../lib/auth";

export default function Nav() {
  const { user, ready, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  // While the session is restoring the role is unknown: keep the public
  // link until restoration decides, so nobody is bounced prematurely.
  const showEvents = !ready || user?.role !== "admin";
  // On the admin page the Admin link would point at itself: hide that
  // self-link but keep identity and Log out. Everywhere else an admin
  // still gets the management shortcut; route guards and the backend
  // stay authoritative.
  const onAdminPage = pathname === "/admin" || pathname.startsWith("/admin/");

  async function handleLogout() {
    // logout() resolves even when server revocation fails: local state is
    // already cleared and only the warning differs. Administration is a
    // management-only flow, so return the signed-out visitor to the public
    // list instead of stranding them on the admin page's "log in as an
    // admin" prompt.
    await logout();
    if (onAdminPage) router.push("/");
  }

  return (
    <nav aria-label="Primary">
      {showEvents && <Link href="/">Events</Link>}
      {ready && user !== null && user.role !== "admin" && (
        <>
          {" · "}<Link href="/bookings">My bookings</Link>
        </>
      )}
      {ready && user?.role === "admin" && !onAdminPage && (
        <>
          {" · "}<Link href="/admin">Admin</Link>
        </>
      )}
      {ready && user !== null && (
        <>
          {" · "}
          <span className="muted">
            {user.email} ({user.role})
          </span>{" "}
          <button type="button" onClick={() => void handleLogout()}>
            Log out
          </button>
        </>
      )}
    </nav>
  );
}
