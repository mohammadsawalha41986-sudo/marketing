# Facebook publishing — production verification

This checklist exists because the automated tests cannot prove the thing that
matters most. Every Graph response in `facebook-publishing.test.ts` is a fake
with a real shape: the tests prove the workflow does the right thing with each
answer, and prove nothing about whether Meta would give that answer.

## Status as of 2026-08-23, deployment `7d4d66c`

**PRODUCTION VERIFICATION BLOCKED BY NETWORK ACCESS** for every step that needs
a Meta API call.

The environment that runs this repository's agent has no route to
`graph.facebook.com`, `www.facebook.com`, or the production host itself —
outbound CONNECT is refused by network policy with HTTP 403, re-confirmed at the
time of writing. It can reach the Railway control plane, which is how the two
steps below were verified for real.

| # | Step | Result |
|---|------|--------|
| 0 | `META_APP_ID` format in production | **PASS** — read from the boot log of deployment `7d4d66c`: `configured (16 chars, numeric=true)`. Configured, numeric, 16 digits (inside 13–20), and not equal to `META_CONFIG_ID` — the line would name that fault. Value never printed. |
| 0 | Schema migration applied in production | **PASS** — `20260823172654_organic_publishing` applied cleanly, `rolledBack=null`. |
| 1 | Worker process running | **PARTIAL** — the process booted and has logged no publishing-tick error, so the timer is installed and not crashing. No job has run, so it has not been *observed* doing work. |
| 2 | Login for Business permissions | **BLOCKED** — needs the Meta app dashboard. |
| 3 | OAuth round trip | **BLOCKED** — no connect attempt has been made on this build; HTTP logs since deploy show only notification polling. |
| 4 | Page discovery | **BLOCKED** — depends on step 3. |
| 5 | Page token storage | **BLOCKED** — depends on step 3. |
| 6 | PawEase content state | **BLOCKED** — the production database is not reachable from here. |
| 7 | Media readable by publisher | **BLOCKED** — depends on step 6. |
| 8 | Readiness checklist | **BLOCKED** — depends on steps 3–7. |
| 9 | Real Facebook publish | **BLOCKED** — depends on all of the above. |
| 10 | Meta response / external post id | **BLOCKED** |
| 11 | Post exists on the Page | **BLOCKED** |
| 12 | Idempotency in production | **BLOCKED** |
| 13 | Failure handling in production | **NOT ATTEMPTED** — verified by automated tests only. Deliberately not exercised against a live customer Page. |
| 14 | Scheduler end-to-end | **BLOCKED** |
| 15 | Retry in production | **BLOCKED** |
| 16 | UI shows published/failed state | **BLOCKED** |

### An important limit on the one PASS

`META_APP_ID` passing **format** validation does not mean Facebook accepts it. The
check proves the value is a number of plausible length that is not the
configuration id. A well-formed id belonging to a *different* Meta app would pass
identically and still return `PLATFORM_INVALID_APP_ID`. Only step 3 settles that.

### Where the remaining steps must be executed

From a machine with ordinary internet access, signed in to both:

- the **Marketing OS production UI** at `marketing-osserver-production.up.railway.app`, as an agency admin; and
- the **Meta app dashboard** for the app whose id is in `META_APP_ID`, as an admin.

Steps 2 and 3 need both. Everything after step 3 is done in the Marketing OS UI
alone. No part of this requires access to this repository's agent environment.

---

Until every step passes, the honest statement is "Facebook publishing is
implemented and untested against Facebook", not "Facebook publishing works".

## 0. Before anything

- [ ] `META_APP_ID` in Railway is the numeric **App ID** from the Meta app
      dashboard. Not the configuration id, not the app secret, not a URL.
- [ ] `META_CONFIG_ID` is the Facebook Login for Business configuration id, and
      is a **different value** from `META_APP_ID`.
- [ ] The Meta app has `pages_manage_posts` granted through the Login for
      Business configuration. This needs App Review; a development-mode app can
      only publish to Pages whose admins are listed as app testers.

## 1. Configuration reaches the running process

- [ ] Deploy, then read the boot log. The line reads:

      meta app id    configured (16 chars, numeric=true)

      If it reads `INVALID — …`, the variable is wrong and the reason is on the
      line. The value is never printed; only its shape.
- [ ] `POST /api/integrations/:clientId/FACEBOOK/connect` returns **200** with a
      `redirectTo`. A 503 naming `META_APP_ID` means the value is malformed.

## 2. OAuth round trip

- [ ] Press Connect. Facebook shows the Business Login dialog, **not** a
      `PLATFORM_INVALID_APP_ID` error page.
- [ ] The dialog offers asset selection — a Page picker. If it does not, the
      configuration is not driving the flow.
- [ ] The browser returns to `/app/integrations?connected=meta&integration=…`.

## 3. Page discovery and token storage

- [ ] The account-selection drawer lists the Page by name.
- [ ] In the database, the `IntegrationAccount` row for that Page has a
      **non-null `accessTokenEnc`** and `tokenStatus` other than
      `REAUTH_REQUIRED`.
      A null token here means Meta returned no Page token — the granted
      permissions do not cover managing that Page, and publishing will refuse.
- [ ] Select the Page. The integration moves to CONNECTED.
- [ ] `GET /api/integrations/:id/accounts` response contains **no token
      material**. Search the raw JSON for the token value; it must not appear.

## 4. Readiness

- [ ] Open an approved post with an image. The Publishing tab shows no
      "Not ready to publish" block.
- [ ] Detach the Page under Integrations. The same tab now names the problem.
      Re-attach it before continuing.

## 5. Text publish

- [ ] Approve a text-only post, press **Publish now**.
- [ ] Within a minute the Publishing tab shows PUBLISHED with a non-empty
      **External post ID**.
- [ ] The permalink opens the real post on Facebook.
- [ ] The post is visible on the Page.

## 6. Image publish

- [ ] Repeat with a post that has one image attached.
- [ ] The published post carries the image, not just the caption.
- [ ] The external post id is the **feed story** id (`{page}_{post}`), not only
      the photo id — the permalink must open a post, not a bare photo.

## 7. Failure is honest

- [ ] Revoke the app's access to the Page in Facebook settings, then retry a
      post. It must reach **PUBLISH_FAILED** with Meta's real reason shown, and
      must **not** show PUBLISHED.
- [ ] `Content.publishedAt` for that post is still null.
- [ ] Reconnect, press **Retry publish**. It publishes, and the Attempts list
      shows both the failure and the success.

## 8. Idempotency

- [ ] With a post already PUBLISHED, press Retry / re-run the worker.
- [ ] No second post appears on the Page.
- [ ] The external post id is unchanged.

## 9. Scheduler

- [ ] Schedule an approved post two minutes out. Leave the browser closed.
- [ ] It publishes without anyone pressing anything, and the timeline shows
      Scheduled → Queued → Published.

## 10. Analytics

- [ ] Metric sync picks the published post up, or — if it does not — the gap is
      recorded rather than shown as zero engagement.

---

## What to report back

For each failing step: the step number, what the UI said, and what the
Publishing tab's error message and code were. Those come from Meta verbatim and
are enough to tell a configuration problem from a code problem without guessing.
