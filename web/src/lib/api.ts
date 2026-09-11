/**
 * API client.
 *
 * Cookies carry the session; the CSRF cookie is echoed back in a header on every
 * mutation, matching the double-submit check on the server.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level messages from a zod failure, when present. */
  get fieldErrors(): Array<{ path: string; message: string }> {
    return Array.isArray(this.details) ? (this.details as Array<{ path: string; message: string }>) : [];
  }
}

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)mos_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

type Body = Record<string, unknown> | FormData | undefined;

async function request<T>(method: string, path: string, body?: Body, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  const isForm = body instanceof FormData;

  if (body && !isForm) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken();

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    signal,
  });

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) throw new ApiError(response.status, 'HTTP_ERROR', response.statusText);
    return (await response.text()) as T;
  }

  const payload = await response.json();

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(response.status, error.code ?? 'UNKNOWN', error.message ?? 'Request failed', error.details);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: Body) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: Body) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** Builds a query string, dropping empty values so URLs stay clean. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// ---------------------------------------------------------------- shared types

export type Role = 'SUPER_ADMIN' | 'AGENCY_ADMIN' | 'AGENCY_STAFF' | 'CLIENT_ADMIN' | 'CLIENT_USER';
export type Language = 'AR' | 'EN';
export type Platform =
  | 'FACEBOOK' | 'INSTAGRAM' | 'TIKTOK' | 'SNAPCHAT'
  | 'GOOGLE_ADS' | 'GOOGLE_BUSINESS' | 'X' | 'LINKEDIN' | 'YOUTUBE'
  /*
   * A publishing route to several of the networks above, not a network itself.
   * It never appears as a post's platform — content keeps naming where it is
   * going — only as the connection a post was routed through.
   */
  | 'UPLOAD_POST';
export type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export type ContentStatus =
  | 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'
  | 'CHANGES_REQUESTED' | 'SCHEDULED' | 'PUBLISHED'
  // FAILED is legacy and still held by older rows; PUBLISH_FAILED is what the
  // publishing pipeline sets, and says which step failed.
  | 'FAILED'
  | 'QUEUED' | 'PUBLISHING' | 'PUBLISH_FAILED' | 'CANCELLED';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
export type MediaType = 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOGO';

export interface BrandColors {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  logoUrl?: string | null;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  locale: Language;
  themePref: string;
  avatarUrl: string | null;
  organizationId: string | null;
  clientId: string | null;
  organization?: { id: string; name: string; slug: string; logoUrl: string | null } | null;
  client?: {
    id: string;
    name: string;
    businessName: string;
    logoUrl: string | null;
    brand: BrandColors | null;
  } | null;
}

export interface Paginated<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
}

export interface Metrics {
  spend: number;
  reach: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  engagements: number;
  /*
   * Ratios are null when they cannot be computed, never 0. A campaign with
   * spend and no conversions has no CPA; rendering 0.00 there would say
   * conversions were free. `reasons` carries the explanation.
   */
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  conversionRate: number | null;
  roas: number | null;
  engagementRate: number | null;
  reasons?: Partial<Record<'ctr' | 'cpc' | 'cpm' | 'cpa' | 'conversionRate' | 'roas' | 'engagementRate', string>>;
}
