# Facebook publishing — production verification

This checklist exists because the automated tests cannot prove the thing that
matters most. Every Graph response in `facebook-publishing.test.ts` is a fake
with a real shape: the tests prove the workflow does the right thing with each
answer, and prove nothing about whether Meta would give that answer.

## Facebook organic publishing — VERIFIED

Confirmed by the operator against the real Meta platform, from an environment
with network access. This is the reference implementation every later provider
is modelled on.

| Check | Result |
|---|---|
| OAuth (Login for Business, existing `config_id`) | **PASS** |
| Page discovery | **PASS** |
| PawEase Page connected — id `1220219831177035` | **PASS** |
| Page Access Token captured | **PASS** |
| Token encrypted at rest, never exposed to the frontend | **PASS** |
| `pages_manage_posts` granted | **PASS** |
| `pages_read_engagement` granted | **PASS** |
| Text publishing → real `externalPostId` | **PASS** |
| Image publishing | **PASS** |
| Post appeared on the real PawEase Page | **PASS** |
| Test Publish action | **PASS** |
| Railway production deployment | **PASS** |

Verified from the application's own boot log, via the Railway control plane:

| Check | Result |
|---|---|
| `META_APP_ID` — configured, 16 chars, numeric, ≠ `META_CONFIG_ID` | **PASS** |
| Migrations applied cleanly in production | **PASS** |

No token, secret or credential is recorded in this document, and none is
recorded in the logs the checks above were read from — the boot line reports the
app id's *shape* only.

---

## Every other provider

**NOT IMPLEMENTED** or **READY — EXTERNAL APPROVAL REQUIRED**, per
`docs/IMPLEMENTATION_PROGRESS.md`. None has been verified against its platform,
and none will be marked PASS on the strength of a mocked test.

---

## Historical: the blocked-verification record

Kept because it explains why the checks above were run the way they were. The
environment that runs this repository's agent has no route to
`graph.facebook.com`, `www.facebook.com`, or the production host — outbound
CONNECT is refused with HTTP 403. Every Graph response in the automated tests is
therefore a fake with a real shape: the tests prove the workflow handles each
answer, and prove nothing about whether Meta gives that answer. Only the
operator-run verification above closes that gap.
