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

export type Language = 'AR' | 'EN';
export type Platform =
  | 'FACEBOOK' | 'INSTAGRAM' | 'TIKTOK' | 'SNAPCHAT'
  | 'GOOGLE_ADS' | 'GOOGLE_BUSINESS' | 'X' | 'LINKEDIN';
export type RestaurantStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
export type CampaignStatus = 'PLANNING' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';
export type CampaignObjective =
  | 'AWARENESS' | 'TRAFFIC' | 'ENGAGEMENT' | 'LEADS' | 'SALES' | 'APP_INSTALLS' | 'VIDEO_VIEWS';
export type ContentStatus = 'IDEA' | 'DRAFT' | 'READY' | 'SCHEDULED' | 'PUBLISHED' | 'ARCHIVED';
export type ContentType =
  | 'POST' | 'STORY' | 'REEL' | 'CAROUSEL' | 'AD_CREATIVE' | 'VIDEO' | 'ARTICLE' | 'EMAIL';
export type AdStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type MediaType = 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOGO';
export type ReportType = 'RESTAURANT' | 'CAMPAIGN' | 'MONTHLY' | 'PLATFORM';

export const CONTENT_STATUSES: ContentStatus[] =
  ['IDEA', 'DRAFT', 'READY', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'];
export const CONTENT_TYPES: ContentType[] =
  ['POST', 'STORY', 'REEL', 'CAROUSEL', 'AD_CREATIVE', 'VIDEO', 'ARTICLE', 'EMAIL'];
export const CAMPAIGN_STATUSES: CampaignStatus[] =
  ['PLANNING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'];
export const CAMPAIGN_OBJECTIVES: CampaignObjective[] =
  ['AWARENESS', 'TRAFFIC', 'ENGAGEMENT', 'LEADS', 'SALES', 'APP_INSTALLS', 'VIDEO_VIEWS'];
export const AD_STATUSES: AdStatus[] = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'];
export const RESTAURANT_STATUSES: RestaurantStatus[] = ['ACTIVE', 'PAUSED', 'ARCHIVED'];
export const TASK_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'];
export const TASK_PRIORITIES: TaskPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const PLATFORMS: Platform[] =
  ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'SNAPCHAT', 'GOOGLE_ADS', 'GOOGLE_BUSINESS', 'X', 'LINKEDIN'];

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
  role: 'OWNER';
  locale: Language;
  themePref: string;
  avatarUrl: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  locale: Language;
  logoUrl: string | null;
}

export interface RestaurantRef {
  id: string;
  name: string;
  businessName?: string;
  logoUrl?: string | null;
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
  leads: number;
  conversions: number;
  revenue: number;
  engagements: number;
  ctr: number;
  cpc: number;
  cpm: number;
  cpa: number;
  costPerLead: number;
  conversionRate: number;
  roas: number;
  engagementRate: number;
}

/** The ratios the API derives for a single ad on every read. */
export interface AdMetrics {
  ctr: number;
  cpc: number;
  cpm: number;
  cpa: number;
  costPerLead: number;
  conversionRate: number;
  roas: number;
}
