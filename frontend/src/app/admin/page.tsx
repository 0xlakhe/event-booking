"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import EventForm, { type EventFormValues } from "../../components/event-form";
import EventDescription from "../../components/event-description";
import { ApiRequestError, adminApi, api, type Attendee, type EventDetail, type TimeFilter } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { NEPAL_LABEL, formatNepal } from "../../lib/datetime";
import { invalidatePublicEventDetail } from "../../lib/public_event_cache";

const PAGE_SIZE = 10;

const TIME_FILTERS: { value: TimeFilter; label: string }[] = [
  { value: "upcoming", label: "Upcoming" },
  { value: "past", label: "Past" },
  { value: "all", label: "All" },
];

function parseTimeFilter(raw: string | null): TimeFilter {
  // Unknown or missing URL values fall back to the default filter.
  return raw === "past" || raw === "all" ? raw : "upcoming";
}

function adminErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case "CAPACITY_BELOW_BOOKINGS":
      return "Total seats cannot go below the number already booked.";
    case "EVENT_HAS_BOOKINGS":
      return "This event still has active bookings and cannot be deleted. Cancel them first.";
    case "EVENT_STARTED":
      return "This event has already started and is read-only history now.";
    case "NOT_FOUND":
      return "This event no longer exists.";
    default:
      return fallback;
  }
}

function isStarted(startsAt: string): boolean {
  // Display gating only; the backend re-checks fresh database time and
  // stays authoritative for every mutation.
  return new Date(startsAt).getTime() <= Date.now();
}

export default function AdminPage() {
  return (
    <Suspense fallback={<main><p className="empty-state" role="status">Loading admin…</p></main>}>
      <Admin />
    </Suspense>
  );
}

function Admin() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, ready, getToken, markSessionExpired, error: authError, clearError } = useAuth();
  const query = params.get("q") ?? "";
  const timeFilter = parseTimeFilter(params.get("time_filter"));
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);

  const [items, setItems] = useState<EventDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [loadedListKey, setLoadedListKey] = useState<string | null>(null);
  const [listFailure, setListFailure] = useState<string | null>(null);
  const [listFailureKey, setListFailureKey] = useState<string | null>(null);
  const [state, setState] = useState<"pending" | "ready" | "error" | "empty">("pending");
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState(query);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EventDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [attendeesFor, setAttendeesFor] = useState<string | null>(null);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [attendeesTotal, setAttendeesTotal] = useState(0);
  const [attendeesPage, setAttendeesPage] = useState(1);
  const listRequestId = useRef(0);
  const attendeesRequestId = useRef(0);

  useEffect(() => setDraft(query), [query]);

  useEffect(() => {
    attendeesRequestId.current += 1;
    setAttendeesFor(null);
    setAttendees([]);
    setAttendeesTotal(0);
    setAttendeesPage(1);
  }, [user?.id]);

  const load = useCallback(async () => {
    const token = getToken();
    const ownerId = user?.id ?? null;
    const key = JSON.stringify([ownerId, query, timeFilter, page]);
    if (token === null) {
      // Invalidate any in-flight responses too, so a pre-sign-out
      // request landing late cannot repopulate the cleared list.
      listRequestId.current += 1;
      setItems([]);
      setLoadedListKey(null);
      setState("empty");
      return;
    }
    const id = ++listRequestId.current;
    setState("pending");
    setListFailure(null);
    setListFailureKey(null);
    try {
      const body = await adminApi.listEvents(token, query, timeFilter, page, PAGE_SIZE);
      if (listRequestId.current !== id || getToken() !== token || user?.id !== ownerId) return;
      setItems(body.items);
      setTotal(body.total);
      setLoadedListKey(key);
      setState(body.items.length === 0 ? "empty" : "ready");
    } catch (err: unknown) {
      if (listRequestId.current !== id || getToken() !== token || user?.id !== ownerId) return;
      if (err instanceof ApiRequestError && err.status === 401) {
        markSessionExpired();
        setItems([]);
        setLoadedListKey(null);
        setState("empty");
        return;
      }
      setState("error");
      setListFailure(err instanceof ApiRequestError ? err.message : "Could not load events.");
      setListFailureKey(key);
    }
  }, [getToken, markSessionExpired, query, timeFilter, page, user?.id]);

  useEffect(() => {
    if (ready && user?.role === "admin") void load();
  }, [ready, user, load]);

  const loadAttendees = useCallback(
    async (eventId: string, attendeesPageNumber: number) => {
      const token = getToken();
      if (token === null) return;
      const id = ++attendeesRequestId.current;
      try {
        const body = await adminApi.attendees(token, eventId, attendeesPageNumber, PAGE_SIZE);
        if (attendeesRequestId.current !== id) return;
        setAttendees(body.items);
        setAttendeesTotal(body.total);
        setAttendeesPage(attendeesPageNumber);
        setAttendeesFor(eventId);
      } catch (err: unknown) {
        if (attendeesRequestId.current !== id) return;
        if (err instanceof ApiRequestError && err.status === 401) {
          markSessionExpired();
          return;
        }
        setFailure(
          err instanceof ApiRequestError
            ? adminErrorMessage(err.code, err.message)
            : "Could not load attendees.",
        );
      }
    },
    [getToken, markSessionExpired],
  );

  async function startEdit(eventId: string) {
    setFailure(null);
    try {
      setEditing(await api.getEvent(eventId));
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.status === 401) {
        markSessionExpired();
        return;
      }
      setFailure(
        err instanceof ApiRequestError
          ? adminErrorMessage(err.code, err.message)
          : "Could not load this event.",
      );
    }
  }

  async function save(values: EventFormValues) {
    const token = getToken();
    if (token === null) return;
    setSaving(true);
    setFailure(null);
    try {
      if (editing === null) {
        await adminApi.createEvent(token, values);
        setCreating(false);
      } else {
        await adminApi.updateEvent(token, editing.id, values);
        invalidatePublicEventDetail(editing.id);
        setEditing(null);
      }
      await load();
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.status === 401) {
        markSessionExpired();
        return;
      }
      setFailure(
        err instanceof ApiRequestError
          ? adminErrorMessage(err.code, err.message)
          : "Saving failed. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function remove(eventId: string) {
    const token = getToken();
    if (token === null || saving) return;
    if (!window.confirm("Delete this event? Cancelled booking history goes with it.")) return;
    setSaving(true);
    setFailure(null);
    try {
      await adminApi.deleteEvent(token, eventId);
      invalidatePublicEventDetail(eventId);
      if (attendeesFor === eventId) setAttendeesFor(null);
      await load();
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.status === 401) {
        markSessionExpired();
        return;
      }
      setFailure(
        err instanceof ApiRequestError
          ? adminErrorMessage(err.code, err.message)
          : "Deletion failed. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  function navigate(nextQuery: string, nextFilter: TimeFilter, nextPage: number) {
    // Filter and page live in the URL so refresh and back/forward restore
    // them; the default filter stays implicit for clean links.
    const searchParams = new URLSearchParams();
    if (nextQuery !== "") searchParams.set("q", nextQuery);
    if (nextFilter !== "upcoming") searchParams.set("time_filter", nextFilter);
    if (nextPage > 1) searchParams.set("page", String(nextPage));
    const suffix = searchParams.toString();
    router.push(suffix === "" ? "/admin" : `/admin?${suffix}`);
  }

  function search(next: string) {
    navigate(next.trim(), timeFilter, 1);
  }

  function go(nextPage: number) {
    navigate(query, timeFilter, nextPage);
  }

  const currentListKey = JSON.stringify([user?.id ?? null, query, timeFilter, page]);
  const hasCurrentList = loadedListKey === currentListKey;
  const hasCurrentListFailure = state === "error" && listFailureKey === currentListKey;
  const isRefreshing = hasCurrentList && state === "pending";
  const visibleItems = hasCurrentList ? items : [];
  const visibleTotal = hasCurrentList ? total : 0;
  const pages = Math.max(1, Math.ceil(visibleTotal / PAGE_SIZE));
  const attendeePages = Math.max(1, Math.ceil(attendeesTotal / PAGE_SIZE));

  return (
    <main>
      <header className="page-heading">
        <h1>Admin events</h1>
        <p>Bring people together. Manage your events and see who’s joining.</p>
      </header>
      {ready && authError !== null && (
        <p role="alert">
          {authError}{" "}
          <button type="button" onClick={clearError}>
            Dismiss
          </button>
        </p>
      )}
      {!ready && <p className="empty-state" role="status">Loading…</p>}
      {ready && user === null && (
        <p>
          <Link href="/login">Log in</Link> as an admin to manage events.
        </p>
      )}
      {ready && user !== null && user.role !== "admin" && (
        <p role="alert">
          Admin access required. Log in with an admin account to manage events.
        </p>
      )}
      {ready && user?.role === "admin" && (
        <>
          <form className="admin-toolbar" role="search"
            onSubmit={(e) => {
              e.preventDefault();
              setDraft(draft);
              search(draft);
            }}
          >
            <input
              type="search"
              placeholder="Search events by title"
              aria-label="Search events by title"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />{" "}
            <button type="submit">Search</button>{" "}
            {!creating && editing === null && (
              <button className="button-primary" type="button" onClick={() => setCreating(true)}>
                New event
              </button>
            )}
          </form>

          <div className="filter-tabs" role="group" aria-label="Filter events by time">
            {TIME_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={timeFilter === option.value}
                onClick={() => {
                  if (timeFilter !== option.value) navigate(query, option.value, 1);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>

          {state === "pending" && <p className={isRefreshing ? "refresh-status" : "empty-state"} role="status">{isRefreshing ? "Updating events…" : "Loading events…"}</p>}
          {hasCurrentListFailure && (
            <p role="alert">
              {listFailure}{" "}
              <button type="button" onClick={() => void load()}>
                Retry
              </button>
            </p>
          )}
          {state === "empty" && hasCurrentList && <p className="empty-state">No events found.</p>}
          {failure !== null && state !== "error" && <p role="alert">{failure}</p>}

          {creating && (
            <div className="card form-panel">
              <h2>New event</h2>
              <EventForm
                pending={saving}
                failure={null}
                submitLabel="Create event"
                onSubmit={(values) => void save(values)}
                onCancel={() => setCreating(false)}
              />
            </div>
          )}

          <ul className="admin-list" aria-busy={isRefreshing}>
            {visibleItems.map((event) => (
              <li key={event.id} className="card admin-card">
                <h2>{event.title}</h2>
                <div className="admin-meta">
                  <span>{event.venue}</span>
                  <time dateTime={event.starts_at} title={NEPAL_LABEL}>{formatNepal(event.starts_at)}</time>
                  <span>{isRefreshing ? "Updating availability…" : `${event.seats_left} / ${event.total_seats} seats left`}</span>
                </div>
                <EventDescription key={event.description} description={event.description} />
                {editing?.id === event.id ? (
                  <EventForm
                    initial={editing}
                    pending={saving}
                    failure={null}
                    submitLabel="Save changes"
                    onSubmit={(values) => void save(values)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <div className="admin-actions">
                    {!isStarted(event.starts_at) && (
                      <p className="button-row">
                        <button type="button" disabled={saving} onClick={() => void startEdit(event.id)}>
                          Edit
                        </button>{" "}
                        <button type="button" disabled={saving} onClick={() => void remove(event.id)}>
                          Delete
                        </button>
                      </p>
                    )}
                    <button
                      type="button"
                      aria-expanded={attendeesFor === event.id}
                      onClick={() => {
                        if (attendeesFor === event.id) setAttendeesFor(null);
                        else void loadAttendees(event.id, 1);
                      }}
                    >
                      {attendeesFor === event.id ? "Hide attendees" : "Attendees"}
                    </button>
                  </div>
                )}
                {attendeesFor === event.id && (
                  <div className="attendee-panel">
                    <h3>Attendees ({attendeesTotal})</h3>
                    {attendees.length === 0 && <p className="muted">No active bookings.</p>}
                    <ul className="attendee-list">
                      {attendees.map((entry) => (
                        <li key={entry.booking_id}>
                          <span>{entry.user.email}</span>
                          <time dateTime={entry.booked_at} title={NEPAL_LABEL}>{formatNepal(entry.booked_at)}</time>
                        </li>
                      ))}
                    </ul>
                    {attendeePages > 1 && (
                      <p className="button-row">
                        <button
                          type="button"
                          disabled={attendeesPage <= 1}
                          onClick={() => void loadAttendees(event.id, attendeesPage - 1)}
                        >
                          Previous
                        </button>{" "}
                        <button
                          type="button"
                          disabled={attendeesPage >= attendeePages}
                          onClick={() => void loadAttendees(event.id, attendeesPage + 1)}
                        >
                          Next
                        </button>
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {hasCurrentList && <div className="pagination">
            <p className="muted">
              Page {page} of {pages} ({visibleTotal} events)
            </p>
            <p className="button-row">
              <button type="button" disabled={page <= 1} onClick={() => go(page - 1)}>
                Previous
              </button>{" "}
              <button type="button" disabled={page >= pages} onClick={() => go(page + 1)}>
                Next
              </button>
            </p>
          </div>}
          <p className="timezone-note">All times shown in {NEPAL_LABEL}.</p>
        </>
      )}
    </main>
  );
}
