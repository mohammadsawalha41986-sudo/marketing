# Implementation Audit — Phase 0

**Date:** 2026-08-16
**Branch:** `claude/marketing-os-production-recovery-ls9pug`
**Scope:** read-only. No source file was modified to produce this document.

This is the baseline for the master implementation command. It records what
exists, what actually runs, what is architecture without a caller, and what is
demo data. Anything below marked ⛔ is a claim the product currently makes that
the code does not support.

---

## 1. Baseline verification

Run before any change, on the commit this document was written against.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** (server + web, no errors) |
| Tests | `npm test` | **PASS** — 19 files, **358/358 tests**, 181s |
| Build | `npm run build` | **PASS** — prisma verify + web (vite) + server (tsc) |

Tests need PostgreSQL. In this container:

```
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/mos -o '-p 5433 -k /tmp' -l /tmp/pg.log start"
export TEST_DATABASE_URL="postgresql://postgres@localhost:5433/marketing_os_test?schema=public&host=/tmp"
```

Test counts by suite: finance 42, workflow 31, storage 28, units 28,
creatives 21, oauth 21, integrations 20, tenancy 20, product-extract 18,
ssrf 18, publishing 17, product-pipeline 15, media-persistence 14,
auth 13, connect-flow 13, resilience 13, adaptive 10, video 10,
storage-driver 7.

---

## 2. Stack, as found

Monorepo, npm workspaces: `server`, `web`, shared `prisma/` at root.

- **Server** — Node 20+, Express 4.21, TypeScript ESM, Zod validation,
  Prisma 6, argon2, helmet, express-rate-limit, multer (memory storage),
  sharp, openai.
- **Web** — React 18, Vite 6, TypeScript, Tailwind, react-router-dom,
  framer-motion, recharts. No state library; hand-rolled `useQuery`.
- **Database** — PostgreSQL. `prisma/schema.prisma`, 1272 lines,
  **34 models, 22 enums**.
- **Deployment** — Railway (`railway.server.json`, Railpack).

This matches what the master command says to preserve. Nothing here needs
migrating.

---

## 3. What genuinely works

Verified by reading the code path end to end and by the test suite.

| Area | State | Evidence |
|---|---|---|
| Auth, sessions, CSRF | **IMPLEMENTED** | `lib/session.ts`, `middleware/auth.ts`; auth.test 13 |
| Tenant isolation | **IMPLEMENTED** | `lib/scope.ts` `scopeWhere`/`orgId`; tenancy.test 20 |
| Storage abstraction | **IMPLEMENTED** | `services/storage/{index,local,s3,objects}.ts`; hand-rolled SigV4, no AWS SDK; storage.test 28 + storage-driver.test 7 |
| Media proxying | **IMPLEMENTED** | `mediaFileUrl()` → `/api/media/:id/file`. No bucket URL ever leaves the server — already satisfies §3 |
| Content-addressed keys | **IMPLEMENTED** | `clients/<clientId>/assets/<hash>`; delete is reference-counted (`deleteObjectIfUnreferenced`) |
| Image creative render | **IMPLEMENTED** | `services/creative/{analyze,compose,render,match,presets}.ts`; adaptive.test 10, creatives.test 21 |
| Video render | **IMPLEMENTED** | `services/video/*`; FFmpeg reported as a *capability* (`ffmpegCapability()`), 503 VIDEO_UNAVAILABLE when absent; video.test 10 |
| Meta publish sequence | **IMPLEMENTED** | `services/integrations/{meta-publish,publish-flow}.ts` — campaign → ad set → upload → creative → ad → **read-back confirm**; provider ids persisted at each step; publishing.test 17 |
| Token encryption | **IMPLEMENTED** | AES-256-GCM, `lib/crypto.ts`; `NO_ENCRYPTION` readiness state |
| OAuth state | **IMPLEMENTED** | `oauth-state.ts` — hashed, single-use, short-lived, tenant-bound |
| SSRF protection | **IMPLEMENTED** | `lib/safe-fetch.ts`; ssrf.test 18 |
| Finance `Figure` type | **IMPLEMENTED** | `services/finance.ts` — `{available:true,value}` \| `{available:false,reason}`; finance.test 42 |
| Brand / Content / Calendar / Approvals / Reports / Notifications / Subscriptions / Admin | **IMPLEMENTED** | workflow.test 31 |

The Meta publish flow in particular already meets §16 and §18 better than the
master command assumes: it never writes `PUBLISHED` without fetching the ad back
from Meta, and it distinguishes `REQUIRES_REAUTH` from `FAILED`.

---

## 4. ⛔ The three findings that block the product promise

### 4.1 ⛔ The real Meta OAuth flow is not reachable from any route

`services/integrations/connect-flow.ts` implements the whole connection:

- `beginAuthorization()` — state, redirect
- `completeCallback()` — code exchange, token encryption, account discovery
- `selectAccounts()` — the explicit per-client account selection §14 demands

It is fully tested (connect-flow.test 13, oauth.test 21). **No route calls any
of the three functions.** Verified:

```
grep -rn "beginAuthorization|completeCallback|selectAccounts" server/src
→ only the definitions in connect-flow.ts
```

The route that *does* exist, `POST /api/integrations/:clientId/:platform/connect`
(`routes/misc.ts:134`), calls `adapter.connect()`. `MetaAdapter` overrides only
`oauth()` — it inherits `BaseAdapter.connect()`, which is:

```ts
async connect(): Promise<{ redirectTo: string }> {
  this.assertConfigured();
  throw new ProviderNotConfiguredError(this.platform, this.label, this.oauth().requiredEnv);
}
```

So even with `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI` and
`TOKEN_ENCRYPTION_KEY` all correctly set, connecting Meta **always** fails with
`PROVIDER_NOT_CONFIGURED`. There is also **no OAuth callback route mounted at
all**.

Consequence: no `Integration` row can ever reach `CONNECTED` in production, so
the Meta publish flow — which is good code — can never run. This is the root
cause of the Meta readiness confusion in earlier sessions, and it is the first
thing Phase 3 must fix.

### 4.2 ⛔ There is no metrics ingestion. Dashboards read seeded data.

`meta.ts` exports `fetchCampaigns()` and `fetchInsights()` with a real
`normalizeInsights()`. **Neither has a caller in `server/src`** — only tests.
`runSync()` likewise: only tests call it.

`POST /api/integrations/:id/sync` (`routes/misc.ts:209`) calls
`adapter.fetchMetrics()`. `MetaAdapter` does not override it, so
`BaseAdapter.fetchMetrics()` runs, which is `return []`. The route then answers:

```json
{ "ok": true }
```

having written nothing. **That is a fake success** and violates §27 and §94
directly.

`AnalyticsSnapshot` is therefore written by exactly one thing: `prisma/seed.ts`.
Every number on the dashboard, in analytics, in the CEO view and in reports is
demo data unless the deployment was never seeded, in which case it is empty.
Nothing in the code marks it as demo.

**Action required before any customer sees production:** confirm whether the
Railway database was seeded. If it was, that data must be labelled or removed —
§60 and §94.

### 4.3 ⛔ Everything except Meta is architecture only

`services/integrations/index.ts` registers eight adapters. Seven of them are
`BaseAdapter` subclasses that override **only `oauth()`** — a real authorize URL,
real scopes, real required env vars, and nothing else.

| Platform | connect | metrics | publish | Honest classification |
|---|---|---|---|---|
| Meta (FACEBOOK/INSTAGRAM) | code exists, **not wired** (4.1) | **none** (4.2) | **IMPLEMENTED** (unreachable without 4.1) | PARTIALLY_IMPLEMENTED |
| Google Ads | throws | `[]` | throws | ARCHITECTURE_ONLY |
| TikTok | throws | `[]` | throws | ARCHITECTURE_ONLY |
| Snapchat | throws | `[]` | throws | ARCHITECTURE_ONLY |
| Google Business | throws | `[]` | throws | ARCHITECTURE_ONLY |
| LinkedIn | throws | `[]` | throws | ARCHITECTURE_ONLY |
| X | throws | `[]` | throws | ARCHITECTURE_ONLY |

To the adapters' credit, `providerReadiness()` already reports
`READY | NOT_CONFIGURED | NO_ENCRYPTION` with the exact missing variable names,
and the UI shows it. What is missing is the second axis §27 asks for: readiness
is about *credentials*, not about *whether we implemented the provider*. A
Google Ads adapter with all four env vars set reports `READY` today and can do
nothing.

---

## 5. Gap analysis against the master command

### 5.1 Creative model (§4) — upload is not a first-class path

`model Creative` requires `sourceMediaId` (non-null), `preset`, `width`,
`height`, `storageKey`, and its doc comment defines it as *"A rendered post
creative"*. Every row is produced by `POST /api/creatives`, which renders.

There is no way to say "this file **is** the ad". Missing:

- `creativeSource` enum — `UPLOADED | RENDERED | GENERATED` (§4)
- `sha256` / checksum for duplicate detection (§4)
- video-shaped metadata on the creative itself

`Media` is also thin for §4/§5: it has `width`, `height`, `mimeType`,
`sizeBytes` — and **no** `durationSeconds`, `fps`, `codec`, `bitrate`,
`hasAudio`, `checksum`. Image dimensions come from sharp on upload
(`routes/media.ts:157`); **video metadata is never extracted at upload** —
`ffprobe` is only used inside the render pipeline.

### 5.2 Validation (§5, §7) — half present

Present: MIME allow-list, an explicit SVG/HTML block list with the XSS reason
stated, and a **real magic-byte sniffer** for images (`sniffImage`, PNG/JPEG/
GIF/WebP/AVIF) enforced on upload. That already satisfies "do not trust the
extension" for images.

Missing:
- No magic-byte check for **video** (MP4/MOV `ftyp` brand is trivial to add).
- No per-placement validation result at all. Nothing produces the §7 matrix
  ("Instagram Feed ✓ / Instagram Story ⚠ wrong aspect ratio / TikTok ✕").
- No `POST /api/creatives/:id/validate` route.

### 5.3 Platform spec engine (§6, §100) — code constants, not an engine

Two hardcoded TypeScript arrays: `services/creative/presets.ts` (12 presets) and
`services/video/placements.ts` (8 placements). Both carry width/height/safeArea
only.

Absent from both: `maxFileSize`, `allowedMimeTypes`, min/max dimensions,
min/max duration, `lastVerifiedAt`, `sourceDocumentationUrl`. There is no
`PlatformSpec` table, so specs cannot be updated without a deploy, and no
`docs/PLATFORM_SPECS.md` exists.

Mitigating: the frontend does **not** hardcode dimensions — it reads
`GET /api/creatives/presets` and `GET /api/videos/placements`. The §6 prohibition
on specs inside React components is already respected.

### 5.4 Tracking and conversions (§20–24) — absent entirely

No UTM fields anywhere. `Campaign.landingPageUrl` exists as a bare string; there
is no `originalUrl`/`trackedUrl` pair, no URL parser, no tracking plan model.

No first-party event model at all (§23): no `ConversionEvent`, no `eventId`,
`orderId`, `leadId`, `platformClickId`. `AnalyticsSnapshot.conversions` is a
single integer with no type — so the system cannot distinguish a purchase from
a lead from a form submit (§22), and `revenue` has no provenance.

### 5.5 Analytics granularity (§30, §58) — too coarse for the product's core feature

`AnalyticsSnapshot` is unique on `(campaignId, platform, date)`. There is **no
adSetId, adId or creativeId column**. Creative-level performance — §34, called
"one of the most important product features" — is not expressible in the current
schema. Any migration here must be additive.

Missing metric fields vs §30: `linkClicks`, `frequency`, `conversionValue`,
`videoViews`, `videoThruplays`, `leads`, `purchases`, `accountId`, and the raw
provider payload.

### 5.6 Money and ratios (§31, §32) — two different standards in one codebase

Storage is correct: `Decimal(12,2)` / `(14,2)` throughout, `currency` stored per
campaign. No float columns.

But there are two conflicting calculation layers:

- `services/finance.ts` — the **correct** one. `Figure` = value or reason;
  `ratio(n, d, whenZero)` returns *unavailable* on a zero denominator.
- `services/analytics.ts` `derive()` — returns **0** for CTR/CPC/CPA/ROAS when
  the denominator is zero:
  ```ts
  const safe = (n, d) => (d === 0 ? 0 : n / d);
  ```
  §32 requires N/A, not 0. This is what feeds the dashboard, the analytics page
  and the AI analyst. A campaign with spend and no conversions currently shows
  **CPA 0.00**, which reads as "free conversions".

`Campaign.currency` defaults to `"USD"` (schema line ~572) and nothing reads
currency back from a provider ad account — §15/§108.

### 5.7 Idempotency (§17) — not present

`AdPublication` has no idempotency key, no operation id, no attempt counter.
`publishToMeta()` guards re-entry by status (`PUBLISHED` → conflict,
`PUBLISHING` → conflict), which prevents a *deliberate* double-publish but not
the §17 scenario: the request times out *after* Meta created the campaign. The
row is left `PUBLISHING`, and the operator cannot retry — the guard blocks it —
so recovery is manual.

Partial credit: provider ids are written to the row **immediately** after each
create, so a failed publish leaves a trail pointing at the real objects. The
`steps` JSON is a genuine audit trail.

### 5.8 Background jobs, scheduling, webhooks (§55–57) — none

Only two `setInterval` timers exist: session pruning (`index.ts:137`) and a
db-health poll. There is no queue, no worker, no Redis, no
`CampaignMonitorScheduler` / `MetricSyncScheduler` / `TokenHealthScheduler` /
`RecommendationScheduler`, and no webhook endpoint with signature verification.

Content has `scheduledAt` and a calendar, but nothing publishes on a schedule.

### 5.9 AI (§10, §11, §35–39) — analysis exists, vision and optimizer do not

Present: `services/ai/*` — OpenAI-backed copy generation and campaign analysis,
Zod-validated, with a labelled template fallback when no key is set
(`aiStatus()`, `isFallback`). AI never writes to the database. `AiUsage` is
recorded. This already satisfies the §11 "fallback must be clearly labelled"
rule.

Absent:
- **No vision.** `services/creative/analyze.ts` measures pixels (focal region,
  luminance, dominant colour) via libvips attention. Its own header says *"there
  is no vision model in this deployment"*. Nothing extracts offer, price, CTA or
  language from a creative — the whole of §10 is unbuilt.
- No `CampaignPlanner` (§12), no `CampaignPreflight` (§80), no
  `CampaignOptimizer` (§35), no recommendation model (§39), no apply-recommendation
  path (§37), no automation guardrails (§38). `campaign-health.ts` exists and is
  the nearest thing to §40.

### 5.10 Frontend (§104, §105)

12 route files. `Creatives` as a first-class library does not exist — creative
work is split across `/app/image-ads`, `/app/video-ads` and the studio, all of
which are *production* surfaces, not upload/validate surfaces. There is no
upload-first "New Campaign" journey (§105). Meta Campaigns (`routes/publishing.tsx`)
drafts against an *already rendered* creative, which is exactly the inversion
§1 asks us to correct.

Arabic/RTL is complete and must stay that way for every new screen (§107).

---

## 6. Migration risk register

| # | Change | Risk | Mitigation |
|---|---|---|---|
| 1 | `creativeSource` on `Creative` | Low | Add enum + column with `@default(RENDERED)` so every existing row keeps its meaning |
| 2 | Make `Creative.sourceMediaId` nullable | **Medium** | Required today. An uploaded creative has no separate source. Nullable is additive and safe; the FK stays |
| 3 | Media metadata columns (`sha256`, duration, fps, codec, bitrate, hasAudio) | Low | All nullable. Backfill is optional and can be lazy |
| 4 | `PlatformSpec` table | Low | New table, seeded from the existing constants so behaviour is identical on day one |
| 5 | Creative/ad-level metrics | **High** | Do **not** alter `AnalyticsSnapshot`'s unique key. Add a new normalized table alongside it and leave existing rollups reading the old one |
| 6 | Tracking + conversion events | Low | New tables only |
| 7 | Publication idempotency key | Low | Nullable column + unique index; existing rows keep null |
| 8 | `CampaignCreative` join (§50) | Medium | Keep `Creative.campaignId` until every reader is migrated; write both for one release |
| 9 | Enum values (`PublicationStatus` +VALIDATING/PARTIALLY_PUBLISHED/PAUSED/COMPLETED) | Low | Postgres `ADD VALUE` is additive; never remove one |

Prohibited throughout, per §89: no `migrate reset`, no `DROP`, no `TRUNCATE`,
no deletion of production rows.

---

## 7. Reality report — current state

| Classification | Items |
|---|---|
| **IMPLEMENTED** | Auth, sessions, CSRF, tenancy, storage (local + S3/R2, proxied), media upload with image magic-byte checks, image creative rendering, video rendering (FFmpeg-gated), Meta publish sequence with read-back confirmation, token encryption, OAuth state handling, SSRF protection, finance `Figure` maths, Brand/Content/Calendar/Approvals/Reports/Notifications/Subscriptions/Admin, bilingual RTL UI |
| **PARTIALLY IMPLEMENTED** | Meta (publish real but unreachable; no OAuth route; no metrics), creative validation (images only, no placement matrix), platform specs (code constants, not an engine), analytics (campaign/day only, zero-denominator returns 0) |
| **ARCHITECTURE ONLY** | Google Ads, TikTok, Snapchat, Google Business, LinkedIn, X — OAuth descriptors and nothing else |
| **NOT PRESENT** | Uploaded-creative model, checksums, video metadata at upload, placement validation results, AI vision, campaign planner, preflight, optimizer, recommendations, apply-recommendation, automation guardrails, tracking/UTM, first-party conversion events, creative-level metrics, metrics ingestion, background queue, schedulers, webhooks, idempotency keys |
| **REQUIRES EXTERNAL CONFIGURATION** | `META_APP_ID/SECRET/REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`, R2/S3 credentials, `OPENAI_API_KEY`, and Meta App Review for `ads_management` |

**The product promise — "You make the ad, AI Marketing runs it" — is not
deliverable today.** Not because the ad-running code is bad; the Meta publish
sequence is the strongest code in the repository. It is because a customer
cannot connect Meta (4.1), cannot upload a finished ad as an ad (5.1), and would
be shown demo numbers if they did (4.2).

---

## 8. Phase order, adjusted for what the audit found

The master command's phase list stands, with one change: **§4.1 is a
prerequisite for everything downstream** and is cheap to fix, so Phase 3 is
partly pulled forward — there is no point validating creatives for a Meta
account that cannot be connected.

| Phase | Work | Depends on |
|---|---|---|
| 0 | This audit | — |
| 1 | Uploaded creative as a first-class object: `creativeSource`, checksum, ffprobe/sharp metadata at upload, video magic bytes | — |
| 2 | `PlatformSpec` engine + validation matrix + `/creatives/:id/validate` + creative library | 1 |
| 3 | **Wire the existing OAuth flow to routes** (connect, callback, discover, select, health); delete the fake-success sync route | — (do early) |
| 4 | Campaign builder over the real publish flow + preflight + idempotency | 1, 2, 3 |
| 5 | Metrics ingestion: call `fetchInsights`, normalize, upsert, cursor, overlap window | 3 |
| 6 | Creative-level metrics table + creative performance | 5 |
| 7 | Optimizer, recommendation model, apply path, guardrails | 6 |
| 8 | Tracking, UTM, first-party conversion events | 4 |
| 9 | Google Ads | 8 |
| 10 | TikTok, Snapchat, others | 9 |

Each phase ends with `npm run typecheck && npm test && npm run build`, a
documented result, the changed-file list, the migration, and the blockers.

---

## 9. Immediate blockers for whoever reads this next

1. **Confirm whether the Railway production database contains seeded demo
   analytics.** If it does, every figure currently on the production dashboard
   is fabricated. This is the highest-priority factual question and it cannot be
   answered from the repository.
2. Meta App Review is required for `ads_management` before any real customer ad
   can be published — external, cannot be coded around.
3. `TOKEN_ENCRYPTION_KEY` was rotated in an earlier session; no provider tokens
   existed under the old key, so nothing needs re-encrypting, but the rotation
   should be confirmed as still in place before Phase 3.
