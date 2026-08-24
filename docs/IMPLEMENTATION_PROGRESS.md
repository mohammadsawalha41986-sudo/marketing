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

## Remaining phases

| Phase | Scope | State |
|---|---|---|
| 3 | Composer `/social/create` — platform tabs, 3-column responsive | Not started |
| 4 | 8 platform-specific preview components | Not started |
| 5 | Media library `/social/library`, `validateMediaForPlatform()` | Not started |
| 6 | Calendar — LIST view, richer cards, filters | Partly exists |
| 7 | Approval workflow across PlatformPost | Backend done in Phase 2 |
| 8 | Scheduler/worker over PlatformPost | Single-platform version exists |
| 9 | Facebook bridge | Done — reuses verified publisher |
| 10 | Instagram | Not started — needs App Review |
| 11 | TikTok | Not started — needs App Review |
| 12 | YouTube / LinkedIn / Google Business | Not started |
| 13 | Meta Ads / Google Ads / TikTok Ads | Not started |
| 14 | Analytics | Partly exists |
| 15 | Report builder | Partly exists |

## External blockers

Not fixable in code — they need approvals from the platforms:

- **Instagram** — content publishing needs App Review on the Meta app
- **TikTok** — content posting API needs audit and approval
- **YouTube** — OAuth verification for upload scope
- **LinkedIn** — Community Management API access
- **Google Business** — API access request

The pattern for each: build OAuth, discovery, selection, permission validation,
the adapter and mocked tests, then mark **READY — EXTERNAL APPROVAL REQUIRED**
rather than claiming a working integration.

## Next exact action

Phase 3 — the composer at `/social/create`, wired to `POST /api/social/post-groups`,
with platform tabs editing one `PlatformPost` each.
