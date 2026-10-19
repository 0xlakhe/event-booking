"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import EventForm from "../../components/event-form";
import EventDescription from "../../components/event-description";
import { ApiRequestError, adminApi, api, type Attendee, type EventDetail, type EventInput, type TimeFilter } from "../../lib/api";
import { cacheAdminEventList, getAdminEventListCacheRevision, getCachedAdminEventList, invalidateAdminEventLists } from "../../lib/admin_event_cache";
import { useAuth } from "../../lib/auth";
import { hasStarted } from "../../lib/clock";
import { NEPAL_LABEL, formatNepal } from "../../lib/datetime";
import { invalidatePublicEventDetail } from "../../lib/public_event_cache";
import { invalidatePublicEventLists } from "../../lib/event_list_navigation";

const PAGE_SIZE = 10;

type AttendeeRequest = { eventId: string; page: number; ownerId: string };
type AttendeeFailure = AttendeeRequest & { message: string };

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
  const [attendeesOwnerId, setAttendeesOwnerId] = useState<string | null>(null);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [attendeesTotal, setAttendeesTotal] = useState(0);
  const [attendeesPage, setAttendeesPage] = useState(1);
  const [attendeesLoaded, setAttendeesLoaded] = useState(false);
  const [attendeesLoading, setAttendeesLoading] = useState<AttendeeRequest | null>(null);
  const [attendeesFailure, setAttendeesFailure] = useState<AttendeeFailure | null>(null);
  const listRequestId = useRef(0);
  const attendeesRequestId = useRef(0);

  useEffect(() => setDraft(query), [query]);

  useEffect(() => {
    attendeesRequestId.current += 1;
    setAttendeesFor(null);
    setAttendeesOwnerId(null);
    setAttendees([]);
    setAttendeesTotal(0);
    setAttendeesPage(1);
    setAttendeesLoaded(false);
    setAttendeesLoading(null);
    setAttendeesFailure(null);
  }, [user?.id, query, timeFilter, page]);

  const load = useCallback(async () => {
    // Bump first: cache hits and sign-out must also supersede in-flight
    // responses, so a late reply cannot land on the newly shown list.
    const id = ++listRequestId.current;
    const token = getToken();
    const ownerId = user?.id ?? null;
    const key = JSON.stringify([ownerId, query, timeFilter, page]);
    if (token === null) {
      setItems([]);
      setLoadedListKey(null);
      setState("empty");
      return;
    }
    if (ownerId !== null) {
      const cached = getCachedAdminEventList(ownerId, query, timeFilter, page);
      if (cached !== null) {
        // Fresh cache hit: show this filter without a second request.
        setItems(cached.items);
        setTotal(cached.total);
        setLoadedListKey(key);
        setListFailure(null);
        setListFailureKey(null);
        setState(cached.items.length === 0 ? "empty" : "ready");
        return;
      }
    }
    setState("pending");
    setListFailure(null);
    setListFailureKey(null);
    const cacheRevision = getAdminEventListCacheRevision();
    try {
      const body = await adminApi.listEvents(token, query, timeFilter, page, PAGE_SIZE);
      if (listRequestId.current !== id || getToken() !== token || user?.id !== ownerId) return;
      if (getAdminEventListCacheRevision() !== cacheRevision) {
        void load();
        return;
      }
      if (ownerId !== null) {
        cacheAdminEventList(ownerId, query, timeFilter, page, body, cacheRevision);
      }
      setItems(body.items);
      setTotal(body.total);
      setLoadedListKey(key);
      setState(body.items.length === 0 ? "empty" : "ready");
    } catch (err: unknown) {
      if (listRequestId.current !== id || getToken() !== token || user?.id !== ownerId) return;
      if (getAdminEventListCacheRevision() !== cacheRevision) {
        void load();
        return;
      }
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
      const ownerId = user?.id;
      if (token === null || ownerId === undefined) return;
      const id = ++attendeesRequestId.current;
      const sameContext = attendeesFor === eventId && attendeesOwnerId === ownerId;
      if (!sameContext) {
        setAttendeesFor(eventId);
        setAttendeesOwnerId(ownerId);
        setAttendees([]);
        setAttendeesTotal(0);
        setAttendeesPage(1);
        setAttendeesLoaded(false);
      }
      setAttendeesFailure(null);
      setAttendeesLoading({ eventId, page: attendeesPageNumber, ownerId });
      try {
        const body = await adminApi.attendees(token, eventId, attendeesPageNumber, PAGE_SIZE);
        if (attendeesRequestId.current !== id || getToken() !== token || user?.id !== ownerId) return;
        setAttendees(body.items);
        setAttendeesTotal(body.total);
        setAttendeesPage(attendeesPageNumber);
        setAttendeesFor(eventId);
        setAttendeesOwnerId(ownerId);
        setAttendeesLoaded(true);
      } catch (err: unknown) {
        if (attendeesRequestId.current !== id || getToken() !== token || user?.id !== ownerId) return;
        if (err instanceof ApiRequestError && err.status === 401) {
          markSessionExpired();
          return;
        }
        setAttendeesFailure({
          eventId,
          page: attendeesPageNumber,
          ownerId,
          message: err instanceof ApiRequestError
            ? adminErrorMessage(err.code, err.message)
            : "Could not load attendees.",
        });
      } finally {
        if (attendeesRequestId.current === id) setAttendeesLoading(null);
      }
    },
    [attendeesFor, attendeesOwnerId, getToken, markSessionExpired, user?.id],
  );

  function closeAttendees(eventId: string) {
    if (attendeesFor !== eventId) return;
    attendeesRequestId.current += 1;
    setAttendeesFor(null);
    setAttendeesOwnerId(null);
    setAttendees([]);
    setAttendeesTotal(0);
    setAttendeesPage(1);
    setAttendeesLoaded(false);
    setAttendeesLoading(null);
    setAttendeesFailure(null);
  }

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

  async function save(values: EventInput) {
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
      invalidatePublicEventLists();
      if (user !== null) invalidateAdminEventLists(user.id);
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
      invalidatePublicEventLists();
      if (user !== null) invalidateAdminEventLists(user.id);
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
                    submitLabel="Save changes"
                    onSubmit={(values) => void save(values)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <div className="admin-actions">
                    {!hasStarted(event.starts_at, Date.now()) && (
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
                      aria-expanded={attendeesFor === event.id && attendeesOwnerId === user?.id}
                      onClick={() => {
                        if (attendeesFor === event.id && attendeesOwnerId === user?.id) closeAttendees(event.id);
                        else void loadAttendees(event.id, 1);
                      }}
                    >
                      {attendeesFor === event.id && attendeesOwnerId === user?.id ? "Hide attendees" : "Attendees"}
                    </button>
                  </div>
                )}
                {attendeesFor === event.id && attendeesOwnerId === user?.id && (
                  <div className="attendee-panel">
                    <h3>Attendees{attendeesLoaded ? ` (${attendeesTotal})` : ""}</h3>
                    {attendeesLoading?.eventId === event.id && attendeesLoading.ownerId === user?.id && (
                      <p className="attendee-loading-status" role="status">Loading attendees…</p>
                    )}
                    {attendeesFailure?.eventId === event.id && attendeesFailure.ownerId === user?.id && (
                      <p role="alert">
                        {attendeesFailure.message}{" "}
                        <button type="button" onClick={() => void loadAttendees(event.id, attendeesFailure.page)}>
                          Retry
                        </button>
                      </p>
                    )}
                    {attendeesLoaded && attendees.length === 0 && attendeesTotal === 0 && (
                      <p className="muted">No active bookings.</p>
                    )}
                    <ul className="attendee-list" aria-busy={attendeesLoading?.eventId === event.id && attendeesLoading.ownerId === user?.id}>
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
                          disabled={attendeesPage <= 1 || (attendeesLoading?.eventId === event.id && attendeesLoading.ownerId === user?.id)}
                          onClick={() => void loadAttendees(event.id, attendeesPage - 1)}
                        >
                          Previous
                        </button>{" "}
                        <button
                          type="button"
                          disabled={attendeesPage >= attendeePages || (attendeesLoading?.eventId === event.id && attendeesLoading.ownerId === user?.id)}
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
