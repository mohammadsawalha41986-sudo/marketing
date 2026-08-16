/**
 * Fetching a URL a user gave us.
 *
 * This is server-side request forgery territory, and the threat is specific: an
 * operator pastes a product URL, and the server — which sits inside a private
 * network, holding a database and cloud metadata credentials — makes the request
 * on their behalf. `http://169.254.169.254/latest/meta-data/iam/` is a perfectly
 * ordinary-looking URL that returns cloud credentials to whoever asks from
 * inside the instance.
 *
 * The defence has to happen at the *IP* level, after DNS resolution, on every
 * hop of every redirect. Blocking hostnames is not enough: `localtest.me` and
 * any attacker-controlled domain can resolve straight to 127.0.0.1, and a
 * redirect from a legitimate host to an internal one is the standard bypass —
 * which is why redirects are followed by hand here rather than handed to fetch.
 *
 * Nothing in this module trusts a value it did not compute itself.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { badRequest } from './errors.js';

export interface SafeFetchOptions {
  /** Hard ceiling on the body, enforced while streaming, not from a header. */
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  /** Accept header to send. */
  accept?: string;
  /** Permit plain http. Off by default: downgrade is a hop worth refusing. */
  allowHttp?: boolean;
}

export interface SafeFetchResult {
  body: Buffer;
  /** Where the response actually came from, after redirects. */
  finalUrl: string;
  contentType: string;
  status: number;
}

const DEFAULTS = {
  maxBytes: 8 * 1024 * 1024,
  maxRedirects: 4,
  timeoutMs: 12_000,
} as const;

/** Schemes that may be fetched at all. `file:`, `data:`, `ftp:` are not here. */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

/**
 * Hostnames refused before DNS is even consulted.
 *
 * The IP checks below are the real defence — this list only short-circuits the
 * obvious cases and, more usefully, gives a clearer error than "resolved to a
 * private address" for a genuine mistake.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** CIDR blocks that must never be reachable from a user-supplied URL. */
const BLOCKED_V4: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private network'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private network'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.168.0.0', 16, 'private network'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

/**
 * Why an address is not fetchable, or null if it is.
 *
 * Returning the reason rather than a boolean is deliberate: the operator who
 * pasted a staging URL deserves to be told it points at a private network, and
 * the log line that records a blocked attempt is far more useful with a cause.
 */
export function blockedAddressReason(address: string): string | null {
  const version = isIP(address);
  if (version === 0) return 'not a resolvable address';

  if (version === 4) {
    const value = ipv4ToInt(address);
    if (value === null) return 'malformed IPv4 address';

    for (const [base, bits, label] of BLOCKED_V4) {
      const baseValue = ipv4ToInt(base);
      if (baseValue === null) continue;
      const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
      if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return label;
    }
    return null;
  }

  const normalized = address.toLowerCase().split('%')[0] ?? '';

  if (normalized === '::' || normalized === '::1') return 'IPv6 loopback';
  // Unique local addresses (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return 'IPv6 unique local address';
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return 'IPv6 link-local';
  if (/^ff[0-9a-f]{2}:/.test(normalized)) return 'IPv6 multicast';

  /*
   * IPv4-mapped and IPv4-compatible forms (::ffff:169.254.169.254) reach the
   * same host as the bare IPv4 address, so they are unwrapped and re-checked
   * rather than treated as an unfamiliar IPv6 address and waved through.
   */
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return blockedAddressReason(mapped[1]);

  return null;
}

/**
 * Resolve a hostname and refuse it if *any* answer is an internal address.
 *
 * Every record is checked, not just the first: a host that returns both a public
 * and a private address would otherwise be usable to reach the private one,
 * since which record a later connection picks is not ours to decide. This is
 * also why the resolved address is pinned into the request below — checking one
 * address and then connecting to whatever DNS returns the second time is the
 * classic time-of-check/time-of-use rebinding hole.
 */
export async function resolvePublicAddress(hostname: string): Promise<string> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.has(host)) throw badRequest(`Refusing to fetch ${hostname}: internal hostname`);
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw badRequest(`Refusing to fetch ${hostname}: internal hostname`);
  }

  // A literal address skips DNS but not the range check.
  if (isIP(host) !== 0) {
    const reason = blockedAddressReason(host);
    if (reason) throw badRequest(`Refusing to fetch ${hostname}: ${reason}`);
    return host;
  }

  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw badRequest(`Could not resolve ${hostname}`);
  }
  if (records.length === 0) throw badRequest(`Could not resolve ${hostname}`);

  for (const record of records) {
    const reason = blockedAddressReason(record.address);
    if (reason) throw badRequest(`Refusing to fetch ${hostname}: resolves to ${reason}`);
  }

  return records[0]!.address;
}

/** Validate a URL's shape and scheme before anything touches the network. */
export function assertFetchableUrl(raw: string, allowHttp = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('That is not a valid URL');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw badRequest(`Refusing to fetch a ${url.protocol.replace(':', '')} URL. Only https is supported.`);
  }
  if (url.protocol === 'http:' && !allowHttp) {
    throw badRequest('Only https URLs can be imported');
  }
  if (url.username || url.password) {
    throw badRequest('Refusing to fetch a URL containing credentials');
  }
  return url;
}

/**
 * Fetch a user-supplied URL with every hop validated.
 *
 * Redirects are followed manually — `redirect: 'follow'` would hand control of
 * the destination to the remote server, which is precisely the thing being
 * defended against.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let url = assertFetchableUrl(rawUrl, options.allowHttp);

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      await resolvePublicAddress(url.hostname);

      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: options.accept ?? '*/*',
          // Identifying the client honestly; some sites serve different markup
          // to an unknown agent, and pretending to be a browser to get around
          // that is not a decision this code should be making silently.
          'user-agent': 'MarketingOS/1.0 (+product importer)',
          'accept-language': 'en,ar;q=0.8',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw badRequest(`The URL returned ${response.status} without a destination`);
        if (hop === maxRedirects) throw badRequest('The URL redirected too many times');

        // Resolved against the current URL so a relative Location works, then
        // re-validated from scratch on the next pass.
        url = assertFetchableUrl(new URL(location, url).toString(), options.allowHttp);
        continue;
      }

      if (!response.ok) throw badRequest(`The URL responded with ${response.status}`);

      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > maxBytes) throw badRequest(`That response is larger than the ${maxBytes} byte limit`);

      const body = await readCapped(response, maxBytes);

      return {
        body,
        finalUrl: url.toString(),
        contentType: (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '',
        status: response.status,
      };
    }

    throw badRequest('The URL redirected too many times');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw badRequest('The URL took too long to respond');
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Read the body, aborting once it exceeds the cap.
 *
 * `content-length` is a claim by the remote server; a hostile or misconfigured
 * one can omit it and stream indefinitely. The only limit that holds is the one
 * counted while reading.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No readable stream to meter, so the whole body arrives at once — the cap
    // still has to be applied to it. Skipping the check here would leave a path
    // where the limit silently does not exist.
    const whole = Buffer.from(await response.arrayBuffer());
    if (whole.byteLength > maxBytes) throw badRequest(`That response is larger than the ${maxBytes} byte limit`);
    return whole;
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw badRequest(`That response is larger than the ${maxBytes} byte limit`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}
