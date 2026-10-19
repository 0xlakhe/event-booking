/**
 * Nepal-time display and input conversion. All event instants are stored
 * and compared in UTC by the backend; this module only presents them in
 * Asia/Kathmandu and converts admin form input back to explicit-offset
 * timestamps. The device timezone is never consulted.
 */

const NEPAL_TIME_ZONE = "Asia/Kathmandu";
const NEPAL_OFFSET = "+05:45";
export const NEPAL_LABEL = "Nepal time (UTC+05:45)";

const displayFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: NEPAL_TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Format an RFC 3339 instant for display in Nepal time. */
export function formatNepal(instant: string): string {
  return displayFormat.format(new Date(instant));
}

/**
 * Convert a `datetime-local` field value (interpreted as Nepal wall time)
 * into an explicit-offset timestamp for the API. Returns null when the
 * shape is wrong; the backend still validates and rejects naive input.
 */
export function nepalInputToTimestamp(local: string): string | null {
  const trimmed = local.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) return null;
  const withSeconds = trimmed.length === 16 ? `${trimmed}:00` : trimmed;
  return `${withSeconds}${NEPAL_OFFSET}`;
}

/**
 * Render an RFC 3339 instant as a `datetime-local` value in Nepal wall
 * time, for prefilling the admin form.
 */
export function nepalInputFromTimestamp(instant: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NEPAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));
  const get = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
