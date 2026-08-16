/**
 * Server-side request forgery.
 *
 * The product importer takes a URL from a user and makes the server fetch it.
 * The server sits inside a private network, next to a database, with cloud
 * metadata one hop away. `http://169.254.169.254/latest/meta-data/iam/` returns
 * credentials to anything asking from inside the instance, and it is an
 * ordinary-looking URL.
 *
 * These are the actual attacks, not a check that a validator function exists:
 * loopback in every notation it can be written, private ranges, the cloud
 * metadata address, IPv6 forms, scheme abuse, and — the one that catches naive
 * implementations — a public host that redirects to an internal one.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import { assertFetchableUrl, blockedAddressReason, resolvePublicAddress, safeFetch } from '../src/lib/safe-fetch.js';

vi.mock('node:dns/promises', async () => {
  const actual = await vi.importActual<typeof import('node:dns/promises')>('node:dns/promises');
  return {
    ...actual,
    lookup: vi.fn(async (hostname: string) => {
      // A tiny controllable resolver. `evil-*` hosts are the attacker-controlled
      // domains that resolve to internal space — the case hostname blocklists
      // cannot catch.
      if (hostname.startsWith('evil-loopback')) return [{ address: '127.0.0.1', family: 4 }];
      if (hostname.startsWith('evil-metadata')) return [{ address: '169.254.169.254', family: 4 }];
      if (hostname.startsWith('evil-private')) return [{ address: '10.1.2.3', family: 4 }];
      if (hostname.startsWith('evil-mixed')) {
        return [
          { address: '93.184.216.34', family: 4 },
          { address: '192.168.1.1', family: 4 },
        ];
      }
      if (hostname.startsWith('evil-v6')) return [{ address: 'fd00::1', family: 6 }];
      if (hostname.startsWith('nxdomain')) throw new Error('ENOTFOUND');
      return [{ address: '93.184.216.34', family: 4 }];
    }),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('address classification', () => {
  it('blocks every private and special-purpose IPv4 range', () => {
    const blocked = [
      '127.0.0.1',
      '127.1.1.1',
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.254',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.0.1',
      '192.168.255.254',
      '169.254.169.254', // AWS / Azure / GCP metadata
      '100.64.0.1', // carrier-grade NAT
      '224.0.0.1',
      '240.0.0.1',
    ];

    for (const address of blocked) {
      expect(blockedAddressReason(address), address).not.toBeNull();
    }
  });

  it('allows ordinary public addresses', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255']) {
      expect(blockedAddressReason(address), address).toBeNull();
    }
  });

  it('blocks IPv6 loopback, unique-local, link-local and multicast', () => {
    for (const address of ['::1', '::', 'fd00::1', 'fc00::abcd', 'fe80::1', 'ff02::1']) {
      expect(blockedAddressReason(address), address).not.toBeNull();
    }
    expect(blockedAddressReason('2606:2800:220:1:248:1893:25c8:1946')).toBeNull();
  });

  it('unwraps IPv4-mapped IPv6, which reaches the same host by another spelling', () => {
    // ::ffff:169.254.169.254 is the metadata endpoint. Treating it as "some
    // IPv6 address we do not recognise" is exactly the bypass.
    expect(blockedAddressReason('::ffff:169.254.169.254')).not.toBeNull();
    expect(blockedAddressReason('::ffff:127.0.0.1')).not.toBeNull();
    expect(blockedAddressReason('::ffff:8.8.8.8')).toBeNull();
  });
});

describe('scheme handling', () => {
  it('refuses schemes that are not http(s)', () => {
    for (const url of [
      'file:///etc/passwd',
      'file://localhost/etc/shadow',
      'ftp://example.com/x',
      'data:text/html,<script>alert(1)</script>',
      'gopher://example.com:70/_',
      'jar:http://example.com!/',
    ]) {
      expect(() => assertFetchableUrl(url), url).toThrow();
    }
  });

  it('refuses plain http unless explicitly allowed', () => {
    expect(() => assertFetchableUrl('http://example.com')).toThrow(/https/i);
    expect(assertFetchableUrl('http://example.com', true).protocol).toBe('http:');
    expect(assertFetchableUrl('https://example.com').protocol).toBe('https:');
  });

  it('refuses credentials embedded in the URL', () => {
    // http://expected-host@attacker/ is a classic way to make a URL read as one
    // host to a human and resolve to another.
    expect(() => assertFetchableUrl('https://user:pass@example.com/')).toThrow(/credentials/i);
  });
});

describe('hostname resolution', () => {
  it('blocks internal hostnames before DNS is consulted', async () => {
    for (const host of ['localhost', 'metadata.google.internal', 'db.internal', 'printer.local']) {
      await expect(resolvePublicAddress(host), host).rejects.toThrow(/internal hostname/i);
    }
  });

  it('blocks a public hostname that resolves into private space', async () => {
    // The reason hostname blocklists are not a defence: the attacker owns the
    // domain and points it wherever they like.
    await expect(resolvePublicAddress('evil-loopback.example.com')).rejects.toThrow(/loopback/i);
    await expect(resolvePublicAddress('evil-metadata.example.com')).rejects.toThrow(/metadata/i);
    await expect(resolvePublicAddress('evil-private.example.com')).rejects.toThrow(/private/i);
    await expect(resolvePublicAddress('evil-v6.example.com')).rejects.toThrow(/IPv6/i);
  });

  it('blocks a host with any private answer, not merely the first', async () => {
    // Picking record[0] and connecting later is a rebinding hole: which record
    // the connection uses is not ours to choose.
    await expect(resolvePublicAddress('evil-mixed.example.com')).rejects.toThrow(/private/i);
  });

  it('rejects a literal internal address written directly', async () => {
    await expect(resolvePublicAddress('169.254.169.254')).rejects.toThrow(/metadata/i);
    await expect(resolvePublicAddress('127.0.0.1')).rejects.toThrow(/loopback/i);
  });

  it('surfaces an unresolvable host as a request error, not a crash', async () => {
    await expect(resolvePublicAddress('nxdomain.example.com')).rejects.toThrow(/resolve/i);
  });

  it('allows a genuinely public host', async () => {
    await expect(resolvePublicAddress('example.com')).resolves.toBe('93.184.216.34');
  });
});

describe('redirect handling', () => {
  function respond(entries: Array<{ status: number; location?: string; body?: string }>) {
    let call = 0;
    return vi.fn(async () => {
      const entry = entries[Math.min(call++, entries.length - 1)]!;
      return {
        ok: entry.status < 400,
        status: entry.status,
        headers: new Headers({
          ...(entry.location ? { location: entry.location } : {}),
          'content-type': 'text/html',
        }),
        body: null,
        arrayBuffer: async () => new TextEncoder().encode(entry.body ?? '').buffer,
      } as unknown as Response;
    });
  }

  it('re-validates the destination on every hop', async () => {
    // The attack: a perfectly innocent public URL that 302s to the metadata
    // endpoint. `redirect: "follow"` would hand the remote server the decision.
    vi.stubGlobal('fetch', respond([{ status: 302, location: 'http://169.254.169.254/latest/meta-data/' }]));

    await expect(safeFetch('https://example.com/product')).rejects.toThrow(/metadata|https/i);
  });

  it('blocks a redirect to a hostname that resolves internally', async () => {
    vi.stubGlobal('fetch', respond([{ status: 301, location: 'https://evil-loopback.example.com/' }]));
    await expect(safeFetch('https://example.com/product')).rejects.toThrow(/loopback/i);
  });

  it('refuses to redirect forever', async () => {
    vi.stubGlobal('fetch', respond([{ status: 302, location: 'https://example.com/next' }]));
    await expect(safeFetch('https://example.com/', { maxRedirects: 3 })).rejects.toThrow(/too many times/i);
  });

  it('follows a legitimate redirect and reports where it landed', async () => {
    vi.stubGlobal(
      'fetch',
      respond([
        { status: 301, location: 'https://example.com/final' },
        { status: 200, body: '<html><title>Ok</title></html>' },
      ]),
    );

    const result = await safeFetch('https://example.com/start');
    expect(result.finalUrl).toBe('https://example.com/final');
    expect(result.body.toString()).toContain('Ok');
  });

  it('rejects a body larger than the cap even when content-length lies', async () => {
    const huge = 'x'.repeat(5000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: null,
        arrayBuffer: async () => new TextEncoder().encode(huge).buffer,
      })) as unknown as typeof fetch,
    );

    // No content-length header at all; the limit has to hold on the bytes read.
    await expect(safeFetch('https://example.com/', { maxBytes: 1000 })).rejects.toThrow();
  });
});
