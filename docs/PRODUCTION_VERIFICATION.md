# Facebook publishing — production verification

This checklist exists because the automated tests cannot prove the thing that
matters most. Every Graph response in `facebook-publishing.test.ts` is a fake
with a real shape: the tests prove the workflow does the right thing with each
answer, and prove nothing about whether Meta would give that answer. The
container that runs CI has no route to `graph.facebook.com` — outbound CONNECT
is refused by network policy — so **no step below has been executed**.

Run it from an environment with network access. Until every step passes, the
honest statement is "Facebook publishing is implemented and untested against
Facebook", not "Facebook publishing works".

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
