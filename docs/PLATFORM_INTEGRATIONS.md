# Platform integrations — what is real

One rule: **an adapter that exists is not an integration that works.** Every
claim below is either backed by code with tests, or labelled as not built.

---

## Two axes, and why one was not enough

`providerReadiness()` answers *is this deployment configured* —
`READY | NOT_CONFIGURED | NO_ENCRYPTION`, with the exact missing variables.

`adapter.implementation` answers *did anyone write the code* —
`IMPLEMENTED | PARTIALLY_IMPLEMENTED | ARCHITECTURE_ONLY | NOT_SUPPORTED`, per
surface.

Readiness alone lied. Google Ads with all four of its variables set reported
`READY` and could do nothing: its adapter overrides `oauth()` and nothing else.
An operator following that signal would go looking for a configuration problem
that does not exist. `GET /api/integrations/catalog` now returns both, plus
`canConnect`, which is the conjunction.

---

## Current state

| Platform | OAuth | Discovery | Publish | Metrics | Conversions |
|---|---|---|---|---|---|
| **Meta** (Facebook / Instagram) | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | ARCHITECTURE_ONLY | NOT_SUPPORTED |
| Google Ads | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | NOT_SUPPORTED |
| TikTok | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | NOT_SUPPORTED |
| Snapchat | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | NOT_SUPPORTED |
| Google Business | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | NOT_SUPPORTED |
| LinkedIn | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | NOT_SUPPORTED |
| X | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | ARCHITECTURE_ONLY | NOT_SUPPORTED |

Meta's `metrics` is **not** IMPLEMENTED. `meta.ts` can fetch and normalize
insights, but nothing ingests them into `AnalyticsSnapshot`, so no figure on any
dashboard comes from Meta. Marking it implemented would put a tick beside
numbers that are still seed data.

---

## The Meta connection

```
POST /api/integrations/:clientId/:platform/connect
      → beginAuthorization()   mints a tenant-bound single-use state,
                               parks the integration in CONNECTING,
                               returns Meta's authorize URL
      → browser follows it

GET  /api/integrations/meta/callback          (no session — see below)
      → completeCallback()     consumes the state, exchanges the code,
                               trades up to a long-lived token, validates it
                               against /me, discovers Pages, Instagram
                               accounts, ad accounts and businesses,
                               stores them ALL UNSELECTED
      → redirects to /app/integrations?connected=meta&integration=…

GET  /api/integrations/:id/accounts    what was discovered
POST /api/integrations/:id/select      → selectAccounts()  ← completes it
GET  /api/integrations/:id/health      → live /me call, not a status column
```

**Why the callback is unauthenticated.** It is a top-level browser navigation
initiated by Meta, and the session cookie may not travel with it. Its
authorisation is the `state`: minted for one organization, one client and one
platform, hashed at rest, single-use, short-lived. `consumeState` decides whose
connection this is — no tenant is ever read from the query string.

**Nothing is attached automatically.** Discovery writes every asset with
`selected: false`. Meta hands back everything the authorizing person can see,
which for anyone managing several businesses includes accounts belonging to
other brands; auto-attaching is precisely how one restaurant's ad account ends
up wired into another's campaigns. `CONNECTED` is reached only by an explicit
selection, and selecting nothing returns the integration to `DISCONNECTED`.

### Configuration

| Variable | Purpose |
|---|---|
| `META_APP_ID` | App id from the Meta app console |
| `META_APP_SECRET` | App secret — never logged, never returned by any route |
| `META_REDIRECT_URI` | **Must** be `https://<host>/api/integrations/meta/callback` |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key; without it no token can be stored and connect answers 503 |

`META_REDIRECT_URI` must be byte-identical in the authorize call, in the token
exchange, and in the app console. `beginAuthorization` treats it as the source
of truth and refuses at connect time if it does not end with the mounted
callback path — otherwise the browser lands somewhere with a code in the query
string and no handler, which looks like "Meta did nothing".

Scopes requested: `ads_management`, `ads_read`, `pages_show_list`,
`pages_manage_posts`, `pages_read_engagement`, `instagram_basic`,
`instagram_content_publish`, `business_management`.

`ads_management` requires **Meta App Review**. Until that is granted, a real
customer publish cannot succeed regardless of code.

---

## API versions — two clocks

```ts
export const GRAPH_VERSION     = process.env.META_GRAPH_VERSION     ?? 'v25.0';
export const MARKETING_VERSION = process.env.META_MARKETING_VERSION ?? 'v25.0';
```

The Graph API and the Marketing API share a host and a version number but not a
lifecycle:

- **Graph** — roughly two years; on expiry it degrades by falling back.
- **Marketing** — roughly one year; on expiry it **fails outright**.

This codebase previously pinned one constant at `v21.0` for both. v21.0 was
released 2 October 2024: still inside the Graph window (expires 21 January 2027)
and long outside the Marketing one — so every campaign, ad set, ad image, ad
creative, ad and insights call was aimed at an expired Marketing API. Publishing
could not have worked in production whatever the credentials said.

Verified 2026-08-16 from secondary sources (`developers.facebook.com` is blocked
by this environment's egress proxy — **confirm against Meta's own changelog
before a production publish**):

- v25.0 is current, released 18 February 2026
- Marketing API v23.0 reached end of life 9 June 2026
- v26.0 expected around September 2026

Both constants are environment-overridable so a version bump is a variable
change, not a deploy.

Ad-object calls (`meta-publish.ts` in full, plus `fetchCampaigns` and
`fetchInsights`) use `MARKETING`. OAuth, `/me`, `/me/accounts`,
`/me/adaccounts` and `/me/businesses` use `GRAPH`.

---

## Publishing

`publishToMeta()` in `publish-flow.ts`, unchanged in substance and now
reachable:

```
confirm the media is in storage
  → confirm the connection is live and has an ad account + Page
  → create campaign      → persist providerCampaignId immediately
  → create ad set        → persist providerAdSetId
  → upload image OR video (waiting for Meta to finish processing video)
  → create ad creative   → persist providerCreativeId
  → create ad
  → FETCH THE AD BACK    ← this is what makes PUBLISHED mean published
```

Provider ids are written after each step, so a failure leaves a row pointing at
the objects that really exist in the operator's account. A credential failure
becomes `REQUIRES_REAUTH` rather than `FAILED`, because retrying it cannot
succeed. The `steps` JSON is the audit trail.

An uploaded creative may now be a video, so the flow branches on the attached
media's type rather than assuming a `Creative` row is a still image.

### Not yet built

- **Idempotency keys.** A timeout after Meta created the campaign leaves the row
  `PUBLISHING` and needs manual recovery. Status guards prevent a deliberate
  double-publish; they do not solve the timeout case.
- **Pause / resume / budget update.**
- **Metric ingestion** — see below.

---

## Metric ingestion

There is none. `fetchInsights()` and `fetchCampaigns()` have no callers outside
tests, and `POST /api/integrations/:id/sync` now answers **501
METRICS_SYNC_NOT_IMPLEMENTED** rather than the `{ ok: true }` it used to return
after calling a `fetchMetrics()` that returns an empty array and writes nothing.

`AnalyticsSnapshot` is written by exactly one thing: `prisma/seed.ts`.

**Anyone reading a dashboard number today is reading seed data or nothing.**
