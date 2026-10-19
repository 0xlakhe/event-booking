"use client";

/* Shared admin event form for creating and editing. Dates are entered
   as Nepal wall time and converted to explicit-offset timestamps;
   the backend remains the authority on bounds and eligibility. */

import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { EventDetail, EventInput } from "../lib/api";
import { NEPAL_LABEL, nepalInputFromTimestamp, nepalInputToTimestamp } from "../lib/datetime";

export default function EventForm({
  initial,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: EventDetail;
  pending: boolean;
  submitLabel: string;
  onSubmit(values: EventInput): void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [startsAt, setStartsAt] = useState(
    initial ? nepalInputFromTimestamp(initial.starts_at) : "",
  );
  const [venue, setVenue] = useState(initial?.venue ?? "");
  const [seats, setSeats] = useState(initial ? String(initial.total_seats) : "");
  const [localError, setLocalError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const timestamp = nepalInputToTimestamp(startsAt);
    if (timestamp === null) {
      setLocalError("Enter a valid date and time.");
      return;
    }
    const total_seats = Number.parseInt(seats, 10);
    if (!Number.isInteger(total_seats) || total_seats < 1) {
      setLocalError("Total seats must be a whole number of at least 1.");
      return;
    }
    setLocalError(null);
    onSubmit({ title, description, starts_at: timestamp, venue, total_seats });
  }

  const field = (label: string, control: ReactNode) => (
    <p>
      <label>
        {label}
        <br />
        {control}
      </label>
    </p>
  );

  return (
    <form className="event-form" onSubmit={submit}>
      {field(
        "Title",
        <input value={title} disabled={pending} onChange={(e) => setTitle(e.target.value)} required />,
      )}
      {field(
        "Description",
        <textarea value={description} disabled={pending} onChange={(e) => setDescription(e.target.value)} required />,
      )}
      {field(
        `Start (${NEPAL_LABEL})`,
        <input
          type="datetime-local"
          value={startsAt}
          disabled={pending}
          onChange={(e) => setStartsAt(e.target.value)}
          required
        />,
      )}
      {field(
        "Venue",
        <input value={venue} disabled={pending} onChange={(e) => setVenue(e.target.value)} required />,
      )}
      {field(
        "Total seats",
        <input
          type="number"
          min={1}
          step={1}
          value={seats}
          disabled={pending}
          onChange={(e) => setSeats(e.target.value)}
          required
        />,
      )}
      {localError !== null && <p role="alert">{localError}</p>}
      <p className="button-row">
        <button className="button-primary" type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>{" "}
        {onCancel && (
          <button type="button" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
        )}
      </p>
    </form>
  );
}
