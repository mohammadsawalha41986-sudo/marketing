# Production Security Audit — 2026-09-03

Triggered by Kaspersky Endpoint Security ("Web Threat Protection", reason
"threat of data loss") blocking the Railway public domain:

    https://marketing-osserver-production.up.railway.app

Scope: determine whether the application itself is compromised or misbehaving,
before treating the warning as a false positive. No security control was
weakened, disabled, or worked around in the course of this audit.

## Verdict

**The application is clean.** No malicious code, no data exfiltration, no
credential harvesting, no injected third-party content, and no exposed secrets
were found. The Kaspersky warning is a domain-reputation classification against
the shared `*.up.railway.app` namespace, not a finding about this application.

## What was checked

### Client-side — the code a browser actually receives

The frontend was built and the shipped bundle inspected directly, rather than
trusting the source tree.

| Check | Result |
|---|---|
| `<script>` tags in shipped `index.html` | Two: one same-origin module (`/assets/…`), one inline theme bootstrap. No third-party scripts. |
| Third-party hosts called at runtime | None. The only external hostnames in the bundle (`reactjs.org`, `reactrouter.com`, `fb.me`, `w3.org`) are error-message and SVG-namespace strings inside React/React Router. |
| Analytics / trackers / ad CDNs | None. |
| Secrets in the bundle | None. No `VITE_`-prefixed variables exist, so nothing server-side can leak into client code. |
| `eval` / `new Function` | None. |
| `innerHTML` / `dangerouslySetInnerHTML` / `document.write` | None. |
| `<iframe>` / `<embed>` / `<object>` | None. |
| Redirects | Two, both same-origin: `/login`, and the OAuth authorization URL returned by our own API. |

### Server-side

| Area | Finding |
|---|---|
| Security headers | `helmet` with a strict production CSP: `default-src 'self'`, `script-src 'self'` + SHA-256 hashes of the inline bootstrap (no `unsafe-inline`), `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`. `x-powered-by` disabled. |
| Passwords | Argon2id, with a constant-time dummy verify on unknown users to close the timing oracle. |
| Sessions | `httpOnly`, `secure` (confirmed on in production), `sameSite=lax`; expired sessions pruned hourly and on read. |
| CSRF | Double-submit cookie compared with a timing-safe equality check on every mutating request. |
| Authorization | Every route module enforces `requireAuth` plus role guards. Only the health endpoint and the OAuth callback are public, both necessarily so. |
| OAuth | 32-byte random state + PKCE verifier, 10-minute TTL, single-use (`consumedAt`), stored server-side. |
| Tokens at rest | Provider credentials encrypted with AES-256-GCM; the app refuses to store them if `TOKEN_ENCRYPTION_KEY` is absent. |
| SQL injection | No `$queryRawUnsafe` / `$executeRawUnsafe` anywhere. The two raw queries use parameterized tagged templates. |
| SSRF | `lib/safe-fetch.ts` resolves DNS and blocks loopback, private, link-local and cloud-metadata ranges (including IPv4-mapped IPv6 forms), re-checking every redirect hop and pinning the resolved address to defeat DNS rebinding. |
| File uploads | In-memory, MIME allowlist, magic-number verification, size and count limits. `image/svg+xml`, `text/html` and `application/xhtml+xml` explicitly blocked. The upload directory is **not** served statically; media goes through tenant-checked API routes. |
| Config disclosure | `/api/storage` reports only booleans plus non-secret region/bucket/host, and is behind `requireAuth`. |

### Deployment

- **Secrets**: no `.env` file is tracked; `.gitignore` covers `.env*` with an
  explicit exception for `.env.example`. No hardcoded credentials in the
  repository — the only connection strings present are a localhost test
  placeholder and documentation placeholders.
- **Railway variables**: all secrets are server-side only (`SESSION_SECRET`,
  `TOKEN_ENCRYPTION_KEY`, `META_APP_SECRET`, S3 keys, `DATABASE_URL`). None are
  client-exposed.
- **Runtime logs**: clean. Database connected, 19 migrations applied, 44/44
  tables present, secure cookies on. No suspicious outbound activity.
- **HTTP logs**: normal traffic only. No scanning, no injection attempts, no
  exfiltration. `/` returns 200.
- **Error rate**: **0 5xx responses across 1,609 requests over 7 days.**

## Findings

No malicious or exploitable defect was found. One hygiene item is worth
tracking:

### Dependency advisories (low priority, no action available)

`npm audit` reports 11 advisories. None is exploitable in production as
deployed:

- **`vitest` (critical), `vite` / `esbuild` (high/moderate)** — development
  dependencies. The advisories require the Vitest UI or the Vite dev server to
  be listening, neither of which runs in production. Fixing requires a major
  bump to `vitest@5`.
- **`qs` / `body-parser` / `express` (moderate)** — a denial-of-service class
  advisory in query-string parsing. `express@4.22.2` is already the newest 4.x
  release and pins the affected `qs` range, so **no patched version exists
  within the current major**. A targeted `overrides` entry for `qs@^6.16.0` was
  attempted and reverted: npm would not resolve it against express's own pin,
  and forcing it risked destabilising request parsing in production for a
  moderate DoS. The real fix is an Express 5 migration, which belongs in its own
  change, not in a security audit.
- **`prisma` / `deepmerge-ts` (high)** — build-time CLI only. `prisma@6.19.3` is
  already the newest 6.x.

`npm audit fix` was run and produced no lockfile change, confirming nothing is
patchable within the current major versions.

## Why Kaspersky flags the Railway domain

`marketing-osserver-production.up.railway.app` is a subdomain of
`up.railway.app`, a namespace shared by every free and hobby Railway
deployment. Reputation systems — Kaspersky's included — score the shared parent
domain, so abuse by unrelated deployments under `*.up.railway.app` degrades the
reputation inherited by every subdomain beneath it. The generic
"threat of data loss" category is a reputation verdict, not a scan result
about this application's content; the same pattern is well documented against
Railway domains for other endpoint products.

Two things follow, and both are consistent with everything above:

1. Nothing in this application can be changed to lift the classification,
   because the classification is not about this application.
2. The durable fix is to stop serving production from a shared-reputation
   namespace — that is, to move to a custom domain, which carries its own
   independent reputation.

**Do not** disable Web Threat Protection or add a blanket exclusion. If an
interim unblock is needed, submit the specific URL to Kaspersky as a false
positive via https://opentip.kaspersky.com — that is the supported route and it
does not weaken protection.

## Custom domain — blocked, needs a real domain

The recommended fix could not be completed: **no custom domain exists to
configure.** Every service across all four Railway projects on this account has
`customDomains: []`, and the repository contains no real domain — only
`your-domain.com` placeholders. No domain name was invented.

To proceed, a domain must be registered (or an existing one named). Then, in
Railway → the `@marketing-os/server` service → Settings → Networking → Custom
Domain, adding the hostname makes Railway display two records that must be
created at the DNS provider:

| Type | Host | Value |
|---|---|---|
| `CNAME` | the subdomain (e.g. `app`) | the `…up.railway.app` target Railway shows |
| `TXT` | as shown by Railway | the verification value Railway shows |

Both are required — without the TXT record Railway will not verify the domain
and it returns 404 instead of routing. The exact values are generated per
domain and only exist after the domain is added, which is why they cannot be
listed here in advance.

Notes:
- An apex domain (`example.com`) needs a provider supporting ALIAS/ANAME
  flattening; a subdomain (`app.example.com`) is simpler and preferred.
- Behind Cloudflare, set the record to **DNS only** (grey cloud) — a proxied
  record breaks Railway's ACME challenge. The `_acme-challenge` record must
  never be proxied.
- SSL is issued automatically by Railway once DNS validates; no manual
  certificate work is needed.
- After the custom domain verifies, set `APP_URL` to it so OAuth redirects and
  absolute links follow, and add the new callback URL to each provider's app
  configuration (Meta, Google, LinkedIn, TikTok) before switching over.
- Keep `marketing-osserver-production.up.railway.app` in place as a fallback
  until the custom domain is verified and tested.

## Not verifiable from this environment

Live HTTP requests to the production host were attempted and refused by this
session's network egress policy (`403` on CONNECT), so response headers could
not be read directly over the wire. Production behaviour was instead verified
through Railway's own telemetry — deploy logs, HTTP request logs, and the error
rate — which is why the header configuration above is reported from source plus
the confirmed `NODE_ENV=production` (which is what switches the CSP on) rather
than from an observed response.
