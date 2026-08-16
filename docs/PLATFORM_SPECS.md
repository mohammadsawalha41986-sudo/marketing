# Platform specifications — source of truth

The engine is `server/src/services/creative/specs.ts`. This document explains
where its numbers came from, how far to trust them, and how to change them.

**Nothing else in the codebase may hardcode a platform limit.** The frontend
reads `GET /api/creatives/specs`; the validator and preflight read the same
array. A dimension written into a React component is a bug.

---

## ⚠️ Verification status

Verified **2026-08-16**, and with an important limitation:
`developers.facebook.com`, `ads.tiktok.com` and the other official documentation
hosts are **blocked by this build environment's egress proxy**, so these values
could not be read from the vendors' own pages. They were transcribed from prior
knowledge and cross-checked against secondary sources.

**Consequence:** a `VALID` from this engine means "our recorded spec accepts
it", not "the platform will accept it". Before the first real customer publish,
someone with network access to the official docs must re-check every row and
update `verifiedAt`.

Where sources disagreed, the **stricter** number was recorded. A spec that is
too tight rejects a workable file, and the operator can see exactly why; a spec
that is too loose lets an ad through to be rejected by the platform, which is
slower and far more confusing.

---

## Recorded placements

| Key | Platform | Surface | Types | Ratio window | Min size | Max file | Duration |
|---|---|---|---|---|---|---|---|
| `FACEBOOK_FEED_IMAGE` | Facebook | Feed | image | 4:5 – 1.91:1 | 600×600 | 30 MB | — |
| `FACEBOOK_FEED_VIDEO` | Facebook | Feed | video | 9:16 – 1.91:1 | 600×600 | 4 GB | 1s – 241min |
| `FACEBOOK_STORY` | Facebook | Story | image, video | 1:2 – 3:5 | 500×889 | 4 GB | 1s – 120s |
| `INSTAGRAM_FEED_IMAGE` | Instagram | Feed | image | 4:5 – 1.91:1 | 600×600 | 30 MB | — |
| `INSTAGRAM_STORY` | Instagram | Story | image, video | 1:2 – 3:5 | 500×889 | 4 GB | 1s – 120s |
| `INSTAGRAM_REEL` | Instagram | Reel | video | 1:2 – 3:5 | 500×889 | 4 GB | 1s – 900s |
| `TIKTOK_IN_FEED` | TikTok | For You feed | video | 1:2 – 16:9 | 540×960 | 500 MB | 5s – 60s |

Sources recorded per row in `sourceUrl`:
- Meta — <https://www.facebook.com/business/ads-guide>
- TikTok — <https://ads.tiktok.com/help/article/tiktok-ads-specifications>

Not yet recorded: Google Ads (asset requirements differ per asset type —
marketing image, square marketing image, portrait, logo, headline, long
headline, description, video — and must come from the Google Ads API
documentation), Snapchat, LinkedIn, X.

---

## Why ranges rather than exact sizes

The product's promise is that the operator's own file runs as it is. A spec
written as "Instagram portrait is 1080×1350" would reject a perfectly good
1080×1349 export. So each placement records the window it serves plus the
recommended shape, and the validator reports the recommended one first because
that is what somebody types into Canva.

`presets.ts` is a different thing and is not a substitute: it holds the sizes we
*render at*. Rendering is optional in this product; validation is not.

---

## The three outcomes

`VALID`, `INVALID`, and `UNKNOWN`.

`UNKNOWN` carries the design weight. A video uploaded to a deployment without
FFmpeg has no measured duration or dimensions. Answering `VALID` would be a
guess presented as a check, and `INVALID` would reject a file that is probably
fine — so the check reports what could not be measured and why, and an unknown
check holds the whole placement at `UNKNOWN`. An unmeasured check never
upgrades to valid.

---

## Changing a spec

1. Read the vendor's current documentation.
2. Edit the row in `specs.ts`, including `verifiedAt` and `sourceUrl`.
3. Add or update a case in `server/test/creative-upload.test.ts`.
4. `npm test`.

Specs are code today, deliberately: they are reviewed, diffed and tested like
anything else. If they start changing faster than releases, move them to a
`PlatformSpec` table seeded from this array — the engine already reads through
`specsFor()`, so nothing downstream would change.
