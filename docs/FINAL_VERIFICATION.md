# Final verification

**Date:** 2026-08-16
**Branch:** `claude/marketing-os-production-recovery-ls9pug`
**Phases in this run:** 0 (audit) → 3 (Meta OAuth) → 1 (creative upload + validation) → 4 (campaign preflight) → 5 (metric ingestion)

---

## Gate results

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** — server + web |
| Tests | `npm test` | **PASS** — 23 files, **413/413** |
| Build | `npm run build` | **PASS** — prisma verify + vite + tsc |
| Schema | `npx prisma validate` | **PASS** |
| Migration | `npx prisma migrate deploy` | **PASS** — applied cleanly |

Baseline at the start of this run was 358 tests. **55 tests added**, none removed,
none weakened.

| Suite | Tests | Covers |
|---|---|---|
| `meta-oauth-routes.test.ts` | 16 | connect / callback / accounts / select / health / sync refusal / catalog |
| `creative-upload.test.ts` | 19 | inspection, hashing, sniffing, placement matrix, upload route, tenancy |
| `preflight.test.ts` | 9 | every block condition, and what preflight must not claim |
| `metric-sync.test.ts` | 11 | ingestion, idempotency, revision, attribution refusal, failure recording |

---

## Feature status

### PASS — verified by tests in this environment

| Feature | Evidence |
|---|---|
| Meta OAuth reachable from the app | `POST /:clientId/:platform/connect` returns a real `facebook.com` authorize URL |
| OAuth callback mounted | `GET /api/integrations/meta/callback` exists, redirects, never echoes the code |
| Per-client account selection | discovery stores unselected; `POST /:id/select` completes or detaches |
| Tenant isolation across new routes | tenant B gets 404 on A's integration, creative and preflight |
| "Not built" separated from "not configured" | Google Ads with all four vars set → 501, not 503 |
| No fake sync success | unimplemented platforms → 501 `METRICS_SYNC_NOT_IMPLEMENTED` |
| Uploaded ad as a first-class creative | `source = UPLOADED`, no source media, no preset, bytes unmodified |
| Measurement from bytes | sharp + ffprobe; declared MIME never decides |
| Video magic bytes | mp4 / mov / webm recognised; renamed text rejected |
| Duplicate detection | same bytes → same sha256 → asset reused |
| Placement validation matrix | states what the file is *and* what the placement needs |
| Unmeasured ≠ valid | no FFmpeg → `UNKNOWN` with the reason, never a tick |
| Campaign preflight | blocks on approval, connection, account, page, currency, dates, missing file, destination |
| Metric ingestion | real provider figures upserted into `AnalyticsSnapshot` |
| Sync idempotency | second sync updates, never duplicates; revisions replace |
| Unattributable spend | skipped with a reason, never guessed onto a campaign |

### NOT VERIFIED HERE — needs a real Meta app and network

| Item | Why not | What proves it |
|---|---|---|
| A live OAuth round trip | needs a browser login against a real Meta app; `developers.facebook.com` and the production host are **blocked by this container's egress proxy** | connect → Meta consent → callback → CONNECTED, once |
| A real publish | needs `ads_management` App Review | one controlled test campaign in a real ad account |
| Real insights ingestion | needs a published campaign | sync after a real publish, compared against Ads Manager |
| Graph / Marketing v25.0 | official docs unreachable from here | re-check against Meta's changelog |

**Nothing in this run should be read as "Meta works end to end in production."**
The code path is complete and tested against the provider's real response
shapes; the round trip against Meta itself has not been executed.

---

## Migration

One migration: `20260816232925_uploaded_creatives`. Purely additive.

```sql
CREATE TYPE "CreativeSource" AS ENUM ('UPLOADED', 'RENDERED', 'GENERATED');
ALTER TABLE "Creative" ADD COLUMN "mediaId" TEXT,
  ADD COLUMN "source" "CreativeSource" NOT NULL DEFAULT 'RENDERED',
  ALTER COLUMN "sourceMediaId" DROP NOT NULL;
ALTER TABLE "Media" ADD COLUMN "sha256" TEXT, "durationSeconds" DOUBLE PRECISION,
  "frameRate" DOUBLE PRECISION, "videoCodec" TEXT, "audioCodec" TEXT,
  "bitrateKbps" INTEGER, "hasAudio" BOOLEAN;
CREATE INDEX … ; ADD CONSTRAINT "Creative_mediaId_fkey" …
```

No `DROP TABLE`, no `DROP COLUMN`, no `TRUNCATE`, no data deletion. Every new
column is nullable or defaulted, so existing rows keep their meaning —
`source` defaults to `RENDERED`, which is what every pre-existing creative was.

---

## Known limitations

1. **`analytics.ts` `derive()` returns 0 for a zero denominator.** A campaign
   with spend and no conversions shows **CPA 0.00**, which reads as free
   conversions. §32 requires N/A. `finance.ts` already has the right pattern
   (`Figure` = value or reason); `derive()` needs to adopt it, and it feeds the
   dashboard, analytics page and AI analyst. **This is the highest-value
   remaining correctness fix.**
2. **Seed data is still unlabelled.** Ingestion now writes real rows alongside
   whatever the seed wrote. Nothing distinguishes them in the UI. Before a
   customer sees production, confirm whether the Railway database was seeded.
3. **No idempotency key on publish.** A timeout after Meta created the campaign
   leaves the row `PUBLISHING` and needs manual recovery.
4. **Metrics are campaign/day only.** `AnalyticsSnapshot` has no adId or
   creativeId column, so creative-level performance (§34) is not yet
   expressible. Requires a new additive table.
5. **No background jobs.** Sync is manual, triggered by the route. No queue, no
   scheduler, no webhooks.
6. **No AI vision, planner, optimizer, recommendations, or tracking/UTM.**
7. **Publications do not yet require a local campaign link**, so an
   advertisement can be published whose metrics later have nowhere to attach.
   The sync reports these; the draft form should set `campaignId`.

---

## External configuration still required

| Item | Status | Note |
|---|---|---|
| `META_APP_ID` | SET in Railway | |
| `META_APP_SECRET` | SET in Railway | |
| `META_REDIRECT_URI` | SET — **value not verifiable** | must be exactly `https://<host>/api/integrations/meta/callback`; connect now refuses at source if it is not |
| `TOKEN_ENCRYPTION_KEY` | SET in Railway | |
| S3/R2 credentials | SET (`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) | driver auto-selects S3 when complete |
| `OPENAI_API_KEY` | **MISSING** | AI content falls back to the template engine, labelled as such |
| Meta App Review for `ads_management` | **REQUIRED, external** | no code change can substitute |
| FFmpeg on the deployment | unknown | absent → video validation reports UNKNOWN rather than failing |

---

## Next step

Fix `derive()` so a zero denominator reports unavailable rather than 0, then
link publications to local campaigns in the draft form, then creative-level
metrics. In that order — the first is a correctness bug in numbers already on
screen, and it is small.
