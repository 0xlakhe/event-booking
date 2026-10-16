/**
 * Typed FastAPI client. Browser calls the API directly; no Next.js
 * proxy, API routes, or Supabase access. Tokens travel in the
 * Authorization header only — never in URLs, HTML, or logs.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000/api";

export interface ApiErrorFields {
  [field: string]: string;
}

export class ApiRequestError extends Error {
  status: number;
  code: string;
  fields?: ApiErrorFields;

  constructor(status: number, code: string, message: string, fields?: ApiErrorFields) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new ApiRequestError(
      res.status,
      typeof err.code === "string" ? err.code : "UNKNOWN",
      typeof err.message === "string" ? err.message : "Request failed.",
      err.fields,
    );
  }
  return payload as T;
}

export interface User {
  id: string;
  email: string;
  role: string;
}

export interface EventSummary {
  id: string;
  title: string;
  starts_at: string;
  venue: string;
  total_seats: number;
  seats_left: number;
}

export interface EventDetail extends EventSummary {
  description: string;
}

export interface Collection<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
}

export interface LoginResult {
  access_token: string;
  token_type: string;
  expires_at: string;
  user: User;
}

export const api = {
  register(email: string, password: string): Promise<User> {
    return request<User>("/auth/register", {
      method: "POST",
      body: { email, password },
    });
  },
  login(email: string, password: string): Promise<LoginResult> {
    return request<LoginResult>("/auth/login", {
      method: "POST",
      body: { email, password },
    });
  },
  me(token: string): Promise<User> {
    return request<User>("/auth/me", { token });
  },
  logout(token: string): Promise<void> {
    return request<void>("/auth/logout", { method: "POST", token });
  },
  listEvents(q: string, page: number, page_size = 10): Promise<Collection<EventSummary>> {
    const params = new URLSearchParams({
      q,
      page: String(page),
      page_size: String(page_size),
    });
    return request<Collection<EventSummary>>(`/events?${params.toString()}`);
  },
  getEvent(id: string): Promise<EventDetail> {
    return request<EventDetail>(`/events/${encodeURIComponent(id)}`);
  },
};
