# Marketing OS — implementation progress

Checkpoint for the multi-phase social agency build. Updated at the end of each
phase so work can resume from here rather than restarting.

**Current phase:** 2 complete → 3 next
**Baseline at start:** 512 tests · **Now:** 527 tests

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

## Phase 8 — Scheduler ✅

`socialTick()` runs alongside the Content sweep in the same 60s tick: due
SCHEDULED → QUEUED, then QUEUED → publish. Bounded retries, idempotency checked
against the database before any provider call.

## Phase 9 — Facebook bridge ✅

`publishPlatformPost` reaches the existing verified `facebookPublisher` through
the `PlatformPublisher` registry. No new OAuth, no new credential store.

## Remaining phases

| Phase | Scope | State |
|---|---|---|
| 5b | `/social/library` browse UI, folders, tags | Not started |
| 6 | Calendar over PlatformPost — LIST view, filters | Not started |
| 7 | Client-portal approval over PlatformPost | Backend done |
| 10 | Instagram | Not started — App Review |
| 11 | TikTok | Not started — API audit |
| 12 | YouTube / LinkedIn / Google Business | Not started |
| 13 | Meta Ads / Google Ads / TikTok Ads | Not started |
| 14 | Analytics over PlatformPost | Partly exists |
| 15 | Report builder | Partly exists |

## External blockers

Instagram (App Review), TikTok (API audit), YouTube (OAuth verification),
LinkedIn (Community Management API), Google Business (API access). For each:
build OAuth, discovery, selection, permission validation, adapter and mocked
tests, then mark **READY — EXTERNAL APPROVAL REQUIRED**.

## Next exact action

Phase 6 — calendar over `PlatformPost`: `GET /api/social/calendar` returning
platform posts in a window, then MONTH/WEEK/DAY/LIST views with drag-to-reschedule.
