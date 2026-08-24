# Marketing OS — implementation progress

Checkpoint for the multi-phase social agency build. Updated at the end of each
phase so work can resume from here rather than restarting.

**Current phase:** 12 complete → 13 next
**Baseline at start:** 512 tests · **Now:** 572 tests

---

## Phase 1 — Architecture audit ✅

Findings that shaped everything after it:

- 20 route modules, 22 mounted API paths, 39 models, ~30 UI routes
- Two provider layers already existed: `BaseAdapter` (paid, honesty model) and
  `PlatformPublisher` + registry (organic publishing)
- **`Content` is single-platform** — one `platform` column, so "one idea across
  six platforms" was inexpressible. This was the gap the whole directive turns on.
- `Platform` enum had no `YOUTUBE`
- Facebook and Instagram shared one `MetaAdapter`

## Phase 2 — PostGroup + PlatformPost ✅

Additive throughout. `Content` untouched, nothing backfilled, the verified
PawEase publication left exactly as it is — a test asserts the `Content` count
does not move.

**Schema** (migration `post_groups`, **0 destructive statements**: 3 CREATE
TABLE, 2 CREATE TYPE, 1 ALTER TYPE ADD VALUE, 8 ADD CONSTRAINT, 11 CREATE INDEX)

- `PostGroup` — one idea, per-client, optionally per-campaign
- `PlatformPost` — one platform's version: own caption, headline, hashtags,
  link, CTA, media, schedule, status, `externalPostId`, retry counters, and a
  `config` JSON for provider-specific settings (never credentials)
- `PlatformPostMedia` — points at the existing `Media` table; no second storage
  system
- `PostGroupStatus` including `PARTIALLY_PUBLISHED`
- `PlatformPostStatus` — its own enum rather than inheriting `ContentStatus`'s
  legacy `FAILED`
- `Platform.YOUTUBE` appended

**Services**

- `social/state.ts` — transition table as data, plus `deriveGroupStatus`. The
  group's status is always computed from its children, never set directly.
- `social/post-groups.ts` — create/edit/transition/publish, tenant guards on
  client, campaign, media and accounts. Publishing reuses the existing
  `PlatformPublisher` registry, so Facebook goes through its verified adapter
  unchanged.

**API** — `/api/social`

| Method | Path |
|---|---|
| POST | `/post-groups` |
| GET | `/post-groups` |
| GET | `/post-groups/:id` |
| DELETE | `/post-groups/:id` |
| PATCH | `/platform-posts/:id` |
| POST | `/platform-posts/:id/publish-now` |
| POST | `/platform-posts/:id/:action` |
| POST | `/post-groups/:id/:action` |

Actions: `submit`, `approve`, `request-changes`, `schedule`, `publish`, `cancel`.

**Tests** — 15 new. Cover per-platform independence, the shared-draft seed,
duplicate-platform refusal, draft→published refusal, edit-after-approval
refusal, group transitions skipping what cannot move, `PARTIALLY_PUBLISHED`,
cross-tenant reads and media, delete-after-publish refusal, and that `Content`
is untouched.

**Bug found by a test:** the generic `/:id/:action` route shadowed
`/:id/publish-now`. Fixed by ordering.

---

## Phase 3 — Composer ✅

`/app/social` (list + create) and `/app/social/:id` (editor). Platform strip
where each tab edits its own `PlatformPost` via `PATCH /platform-posts/:id`.
Three columns at desktop, two at tablet, tabs on mobile. Edits are local until
saved; the seed effect is keyed on post id so a refetch cannot wipe unsaved work.
`Platform.YOUTUBE` propagated to the frontend type.

## Phase 4 — Platform previews ✅

`web/src/components/platform-previews.tsx` — 8 components: Facebook, Instagram
Feed/Carousel/Reel, TikTok, YouTube, LinkedIn, Google Business. `PlatformPreview`
dispatches by platform + variant; an unknown platform says so rather than
borrowing Facebook's chrome.

## Phase 5 — Media validation ✅ (library UI pending)

`services/social/media-rules.ts` — per platform *and surface*, since an
Instagram feed post and a Reel disagree about orientation. Returns findings, not
a boolean: WARNING (will be cropped) and INCOMPATIBLE (will be refused) need
different words. `GET /platform-posts/:id/readiness` exposes it. 11 tests.
Still to do: the `/social/library` browse UI, folders and tags.

## Phase 6 — Content calendar ✅

`/app/social/calendar`. `GET /api/social/calendar` returns platform posts in a
window (unit = one platform post, not a group). Month grid with drag-to-reschedule
(moves the day, keeps the time), week/day columns, and a list view. Reschedule
refuses anything already published.

## Phase 8 — Scheduler ✅

`socialTick()` runs alongside the Content sweep each 60s tick: due SCHEDULED →
QUEUED, then QUEUED → publish, bounded retries, DB-checked idempotency.

## Phase 9 — Facebook bridge ✅

`publishPlatformPost` reaches the verified `facebookPublisher` through the
registry. No new OAuth or credential store.

## Phase 10 — Instagram ⚠️ READY — EXTERNAL APPROVAL REQUIRED

Real two-step container/publish adapter (`instagram.ts`), registered as a live
publisher. Blocked on two things no code can grant: App Review for
`instagram_content_publish`, and a public delivery URL for media (the adapter
refuses INVALID_MEDIA rather than hand Meta an authenticated link). 6 tests.
`PublishMedia.publicUrl` added for URL-based providers.

## Phase 12 — LinkedIn / Google Business / YouTube ✅

**LinkedIn** — text posting via `/rest/posts` API with org URN author. Image
posting deferred (three-call dance). `canPublish: true`, gated on
`w_organization_social` approval. 5 tests.

**Google Business** — `localPosts` API adapter supporting UPDATE (text + image),
OFFER (coupon code + redemption URL), and EVENT (title + date range) post types.
Image via `publicUrl` (Google fetches it). Config passed through
`PlatformPost.config`. Gated on `business.manage` OAuth scope. 10 tests.

**YouTube** — resumable upload via YouTube Data API v3: init with metadata
(`snippet` + `status`), then PUT video bytes. Supports title, description, tags,
privacy status, madeForKids via config. Refuses text-only posts honestly (no
community post API). Gated on `youtube.upload` scope. 8 tests.

All three registered in the publisher registry with `canPublish: true`.

## Remaining phases

| Phase | Scope | State |
|---|---|---|
| 5b | `/social/library` browse UI, folders, tags | Not started |
| 11 | TikTok — resumable video upload | Not started — API audit |
| 13 | Meta Ads / Google Ads / TikTok Ads | Not started |
| 14 | Analytics over PlatformPost | Partly exists |
| 15 | Report builder | Partly exists |

## Provider status

| Provider | Status |
|---|---|
| Facebook | **PASS** — real-world verified |
| Instagram | **READY — EXTERNAL APPROVAL REQUIRED** (App Review + public media) |
| TikTok | NOT IMPLEMENTED — API audit |
| YouTube | **READY — EXTERNAL APPROVAL REQUIRED** (youtube.upload scope; video only) |
| LinkedIn | **READY — EXTERNAL APPROVAL REQUIRED** (w_organization_social; text only) |
| Google Business | **READY — EXTERNAL APPROVAL REQUIRED** (business.manage scope) |
| Meta/Google/TikTok Ads | NOT IMPLEMENTED |

## Next exact action

Phase 13 — Ads Hubs (Meta Ads / Google Ads / TikTok Ads), kept separate from
organic publishing. Then Phase 14 (analytics over PlatformPost).
