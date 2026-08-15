# Restaurant Marketing OS

A private marketing management system for **one operator** running marketing for
**many restaurants**. Not a SaaS product: the restaurants are service clients,
not application users. They have no accounts, no logins and no portal.

```
OPERATOR → RESTAURANT → BRAND → MEDIA → AI CONTENT → CAMPAIGN → AD
        → CALENDAR → PUBLISHING → ANALYTICS → AI ANALYSIS → REPORT
```

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | React 18, Vite 6, TypeScript, Tailwind CSS, React Router 7, Recharts, Framer Motion |
| Backend | Node 20.9+ (verified on 22.x), Express 4, TypeScript (ESM) |
| Database | PostgreSQL 16 via Prisma 6 |
| Validation | Zod, on every request body, query and path parameter |
| Auth | Opaque session tokens in HTTP-only cookies, Argon2id password hashing |
| AI | OpenAI through a backend service, with a built-in generator as fallback |
| Storage | Provider interface with a local-disk driver |

No Docker required. In production a **single Node process** serves both the API
and the built SPA, which is what makes this deployable as one Railway service.

## Quick start

```bash
npm install                   # also generates the Prisma Client
cp .env.example .env          # local development only; fill in DATABASE_URL and SESSION_SECRET
npx prisma migrate deploy
npm run owner:create -- --email you@example.com --name "Your Name"
npm run build
npm start                     # http://localhost:3000
```

For development with hot reload on both sides:

```bash
npm run dev                   # API on :3000, Vite on :5173
```

`npm run db:seed` loads a demo workspace — one operator and four restaurants in
Riyadh, Jeddah, Dubai and Amman, with campaigns, ads, content, tasks and 90 days
of analytics. It creates a demo login (`owner@marketing.example.com` /
`Passw0rd!demo`), so **do not run it on a real deployment**.

## There is no sign-up

This is the one thing to understand before deploying it.

There is no registration route, no invitation flow and no password-reset email.
The application has exactly one account, and it is created out of band by
someone who already holds the database credentials:

```bash
npm run owner:create -- --email you@example.com --name "Your Name"
```

The password comes from `OWNER_PASSWORD` or a prompt with echo off — never from
a command-line argument, because argv is readable by every other process on the
machine and lands in shell history. Re-running the command against an existing
email resets that password and signs out every session, which is the recovery
path in place of a reset link.

An open registration endpoint on a system like this would hand full access to
every restaurant's data to anyone who found the URL. The test suite asserts that
`/api/auth/register`, `/api/auth/forgot-password` and `/api/auth/reset-password`
all return 404, so they cannot quietly come back.

## What is real, and what is not

Stated plainly, because "looks finished" and "is finished" are different things.

### Fully working against the database

Owner authentication and sessions · restaurant CRUD and archiving · brand
identity · logo upload with colour extraction · palette approval · media library
· campaign CRUD · ad CRUD with manual performance entry · content CRUD · AI
content generation · hashtag generation · Arabic and English · unified content
calendar with filtering and rescheduling · tasks · notifications · analytics ·
report generation and export · workspace settings · audit log.

### Deliberately not pretending

- **Ad-platform integrations are architecture only.** Meta, TikTok, Snapchat,
  Google Ads, Google Business, LinkedIn and X each have an adapter behind a
  shared interface, with real routes, credential storage and connection status.
  Every adapter returns **HTTP 501** naming the environment variables it needs.
  Nothing reports a connection that does not exist.
- **Ad performance figures are entered by hand.** Because no integration exists,
  the Ads section makes manual entry a first-class workflow rather than
  inventing a fetch. An ad whose figures have never been entered shows
  "not recorded", never a row of zeroes — `metricsAt` is null until the operator
  records something, and the dashboard raises it as a gap to close.
- **Publishing is not wired up.** Scheduling writes a calendar entry and sets a
  status; "mark published" records that *the operator* published it. Neither
  posts to any network.
- **Analytics data is seeded, not fetched.** `AnalyticsSnapshot` rows come from
  the seed script. Every number in the UI is computed from those rows — none is
  hard-coded — but they describe fictional restaurants until a real integration
  fills the table.
- **AI falls back when no key is set.** Without `OPENAI_API_KEY` the built-in
  template engine writes the copy, and the UI labels it "Built-in engine" on
  every result. Set the key and the same endpoints call the model instead.

## Architecture

```
prisma/schema.prisma     23 models, everything hangs off Restaurant
server/src/
  env.ts                 Zod-validated config; refuses to boot on a bad one
  app.ts                 Express assembly (helmet, CORS, CSRF, rate limits, SPA)
  lib/workspace.ts       the settings singleton
  middleware/            auth, validation, uploads, error handling
  services/
    ai/                  bounded context → provider → schema validation
    analytics.ts         every figure in the product is computed here
    palette.ts           logo colour extraction, WCAG contrast
    storage/             provider interface + local disk driver
    integrations/        one adapter per ad platform
  routes/                one router per resource
web/src/
  lib/                   api client, auth, theme, i18n, formatting
  components/            design system, charts, domain components, app shell
  routes/                one surface, no portal and no admin area
```

### No tenancy layer

Earlier versions of this application were multi-tenant, with `Organization` as
the boundary and a `scope.ts` that derived row access from the session. Both are
gone. One operator owns every row, so there is no scope to derive and no tenant
to isolate — authentication alone decides whether a request may proceed.

Restaurants are still kept strictly apart from one another, but as ordinary
foreign-key correctness rather than access control:

- an ad takes its restaurant **from its campaign**, never from the request body
- content can only be attached to a campaign belonging to its own restaurant
- an ad can be moved between campaigns only within the same restaurant
- the restaurant on a campaign or a content item is fixed at creation

Those rules are what stop one restaurant's spend appearing on another's report,
and each has a test.

### AI architecture

```
request → brand context assembled by the caller → AI service → provider
        → zod schema validation → forbidden-word scrub → result → user edits → save
```

The AI service has no database access and no Prisma client. It receives a plain
`BrandContext` for **one** restaurant and returns validated structure. It cannot
write records: generation is a pure read, and the operator saves the result
through the normal content endpoints after editing it.

For campaign analysis the model receives only figures already computed from
`AnalyticsSnapshot` rows, and the system prompt forbids stating any number not
present in that object. The fallback analyst is rule-based and quotes only the
figures it was handed.

### Derived metrics are never stored

CTR, CPC, CPM, cost per lead and ROAS are computed on every read, for both
snapshots and individual ads. They are deliberately not columns: a stored rate
is a second copy of what its inputs already say, and the two only ever disagree
— the moment a figure is corrected, every rate saved beside it is wrong until
someone recomputes it.

## API

| Prefix | Purpose |
| --- | --- |
| `/api/auth` | login, logout, me, change password |
| `/api/restaurants` | restaurant CRUD, per-restaurant overview, archive |
| `/api/brands` | brand identity, logo upload, palette suggest/approve |
| `/api/media` | upload, browse, retag, delete, storage usage |
| `/api/campaigns` | campaign CRUD, platform mix, per-campaign analytics |
| `/api/ads` | ad CRUD and recording measured performance |
| `/api/content` | content CRUD, AI generation, hashtags, schedule, publish |
| `/api/calendar` | month/week/day views, drag-to-reschedule |
| `/api/analytics` | dashboard, series, AI marketing analyst |
| `/api/reports` | generate, read, export as HTML or Markdown |
| `/api/tasks` | marketing tasks and follow-ups |
| `/api/notifications` | list, mark read |
| `/api/integrations` | adapter catalogue, connect, disconnect, sync |
| `/api/settings` | workspace settings, storage and AI status |

## Routes

`/dashboard` `/restaurants` `/restaurants/:id/:tab` `/content` `/content/:id`
`/campaigns` `/campaigns/:id` `/ads` `/ads/:id` `/calendar` `/media`
`/analytics` `/reports` `/reports/:id` `/ai` `/tasks` `/brand` `/notifications`
`/settings`

Public: `/login` — and nothing else.

Opening a restaurant gives a workspace with tabs for overview, brand, content,
campaigns, ads, calendar, media, analytics, reports and tasks. Those tabs do not
reimplement anything: each renders the same page the sidebar does, scoped to one
restaurant, so a fix in one place is a fix in both.

## Security

- Argon2id password hashing at OWASP-recommended parameters.
- Opaque 256-bit session tokens; only their SHA-256 hash is stored, so a database
  leak does not hand over live sessions.
- HTTP-only, SameSite=Lax cookies; `Secure` in production.
- Double-submit CSRF on every authenticated mutation.
- Rate limiting globally and tighter on credential endpoints.
- Zod validation on every input.
- **No public account creation or recovery surface at all.**
- Upload validation by MIME **and** magic number. SVG is rejected outright — it
  is an executable document and would be stored XSS.
- Uploads served with `nosniff` and a restrictive CSP.
- Helmet security headers, with a full CSP in production.
- Integration credentials are never included in any API projection.
- Deactivating the account deletes its sessions immediately.
- No secrets in the repository; `.env` is git-ignored and `.env.example`
  documents every variable.

## Internationalization

Arabic and English, with full RTL. The language switcher flips `dir` on `<html>`
immediately — no reload — and the choice is persisted. Layout uses logical
properties (`ms-`, `me-`, `start-`, `end-`) so it mirrors correctly. Numeric
spans are marked `dir="ltr"` so signs and currency symbols stay on the correct
side.

Content is generated independently in either language: the AI writes native
Arabic marketing copy, not a translation of the English.

**Known gaps**, verified in a browser rather than assumed:

- Navigation, KPI labels, the primary action buttons, empty states and all
  formatting are translated, and the layout mirrors correctly at every viewport.
- Page subtitles, form field labels and modal titles are still English. They are
  descriptive rather than navigational, so the app is usable in Arabic, but it is
  not fully localized.
- Alert and notification text generated server-side is English only, because it
  is composed from live figures on the server where no locale is in scope.

## Currency

The workspace currency defaults to **SAR** and is set in Settings. It is not
hard-coded anywhere: money formatting reads it at runtime, new campaigns inherit
it, and a generated report freezes the currency it was produced in so an old
report does not silently re-denominate when the setting changes.

## Testing

```bash
npm run typecheck    # server + web
npm run lint         # eslint across both workspaces
npm test             # 114 server tests against a real PostgreSQL database
npm run build        # production build of both
npm run verify       # typecheck, test, build
```

The tests run against real PostgreSQL, not a mock — a mocked Prisma client would
prove nothing about whether the queries are actually correct. Coverage includes
authentication and sessions, CSRF, **the absence of every account-creation
route**, restaurant data integrity (including cross-restaurant attempts by id),
restaurant and campaign CRUD, the content pipeline and scheduling rules, ad
metric entry and rate derivation, tasks, calendar filtering and rescheduling,
report generation and export, analytics maths at the boundaries, AI generation
including forbidden-word scrubbing and Arabic output, brand-context isolation
between restaurants, upload validation including a file that lies about its MIME
type, workspace settings, and the integration adapters' refusal to fake a
connection.

Set `TEST_DATABASE_URL` to point the suite at a different database; it defaults
to `marketing_os_test`.

## Deploying to Railway

Target architecture — one service plus a database:

```
Browser → Railway service ┬─ Express API
                          └─ React build (web/dist)
                                 ↓
                          Railway PostgreSQL
```

### 1. Create the project

Create a Railway project, add your repository as a service, and add a
**PostgreSQL** database to the same project.

`railway.json` in the repository root already configures the build, the
migration step, the start command and the health check, so there is nothing to
fill in on the Build/Deploy settings pages:

```json
{
  "build":  { "builder": "RAILPACK", "buildCommand": "npm run build" },
  "deploy": {
    "preDeployCommand": ["npx prisma migrate deploy"],
    "startCommand": "npm start",
    "healthcheckPath": "/api/health"
  }
}
```

`preDeployCommand` runs the migrations against the live database before the new
version starts taking traffic, and a failure there stops the deploy rather than
releasing code against a schema that does not match it.

### 2. Set the variables

On the app service:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
SESSION_SECRET=<48 random characters>
NODE_ENV=production
```

`DATABASE_URL` must be the **reference**, not a pasted string — that is what
makes it resolve over Railway's private network and follow the database if its
credentials rotate.

Generate the secret locally and paste the result:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Everything else has a working default. **Do not set `PORT`** — Railway injects
it, and setting it yourself is a common cause of a process that starts but never
receives traffic. **Do not set `APP_URL`** unless you are using a custom domain:
it is derived from Railway's `RAILWAY_PUBLIC_DOMAIN`.

### 3. Add a volume for uploads

Attach a volume to the app service with mount path **`/app/storage`**.

Without one, uploaded logos and media are written to the container filesystem,
which is replaced on every deploy — the database rows survive and point at files
that no longer exist. If you would rather not run a volume, add a remote driver
in `server/src/services/storage/` and switch `STORAGE_DRIVER`.

### 4. Generate a domain, then create the owner account

Generate a domain from the service's Settings → Networking. Then open the
service shell and create the single account:

```bash
npm run owner:create -- --email you@example.com --name "Your Name"
```

Set `OWNER_PASSWORD` in the shell first, or let it prompt. Do **not** run
`npm run db:seed` on a real deployment — it creates a demo login with a
published password.

### 5. Verify

```
https://your-app.up.railway.app/api/health   →  {"status":"healthy","database":"ok",…}
https://your-app.up.railway.app/login        →  the sign-in page
```

Then check the deploy log. A healthy boot prints:

```
[marketing-os] started
  environment    production
  node           v22.x.x
  listening      0.0.0.0:<port>
  app url        https://your-app.up.railway.app
  front end      served from web/dist
  secure cookies on
  database       checking in the background…
[marketing-os] database connected
```

The last line arrives a moment after the rest, and that ordering is deliberate:
the server binds its port first and checks the database afterwards.

### Startup order, and why nothing awaits before `listen()`

A managed host kills a process that has not called `listen()` within a few
seconds. That makes any `await` in front of `listen()` a deployment hazard, and
a database ping the worst kind: an unreachable database stops being a degraded
feature and becomes an unrecoverable boot loop, which the browser only ever
shows as a 502.

So the entry point does exactly three things, in this order:

1. validate configuration — synchronous, no network
2. `app.listen()` — nothing is allowed to run before this
3. everything else, in the background

The database is probed from inside the `listen` callback. If it is unreachable
the app still starts and still serves pages; `/api/health` reports
`{"status":"degraded"}` with HTTP 503, the log prints the full diagnostic, and a
background watcher re-checks every 60 seconds so the app recovers on its own
once the database comes back.

### The Prisma query engine

Prisma ships a native query engine that must match the OpenSSL version of the
machine that *runs* the app, and the engine type is baked into the client when
it is generated. `prisma/schema.prisma` pins both:

```prisma
generator client {
  provider      = "prisma-client-js"
  engineType    = "binary"
  binaryTargets = ["native", "debian-openssl-3.0.x"]
}
```

`binary` runs the engine as a separate child process rather than loading it into
Node. On a constrained host the library engine loses the race to spawn its timer
thread and panics with `PANIC: timer has gone away`; measured here, the Node
process holds 15 threads with the library engine and 7 with the binary one.

`npm run build` verifies what was actually generated and **fails the build** on
a mismatch, so the wrong engine can never ship silently:

```
[prisma] engine "binary" verified; 1 engine file(s): query-engine-debian-openssl-3.0.x
```

If a panic ever does appear, the app replaces the poisoned client and keeps
serving — at most once every 30 seconds, and it stops after 5 consecutive
replacements, because a fresh engine panicking five times running is not
transient. `/api/health` reports `engineRecoveries`; `0` is healthy.

## Troubleshooting

### The deploy fails during the pre-deploy step

Migrations could not be applied. The log names the Prisma error. Usually
`DATABASE_URL` is a pasted string rather than the `${{Postgres.DATABASE_URL}}`
reference, or the database service is not in the same project. This failing
stops the deploy on purpose — the alternative is a running app whose code does
not match its schema.

### `/api/health` returns `{"status":"degraded"}` with HTTP 503

The process is healthy; the database is not. Pages still render. The log carries
the diagnostic and names which of two cases applies: a driver error such as
*Can't reach database server at …* (credentials, host, firewall, or missing
SSL — add `?sslmode=require` for an external provider), or an engine panic,
which `"engine":"panicked"` in the response says too.

The connection string is never written to the log — it contains a password.

### Pages 404 but `/api/health` works

The front end was not built. The startup log says `front end NOT BUILT`. The
build command must be `npm run build`, which builds `web/dist` first.

### API returns HTML instead of JSON

Something is serving `index.html` for `/api/*`. In this app the SPA fallback
explicitly skips `/api` and `/uploads`; if you put another proxy in front, it
must do the same.

### Login appears to work but every page bounces back to sign-in

The session cookie is being dropped. Almost always one of:

- **`APP_URL` does not match the browsed domain**, so the request is treated as
  cross-origin. On a custom domain, set `APP_URL` to it.
- **Site is on HTTP while `COOKIE_SECURE` is on.** Railway domains are HTTPS, so
  this is only reachable with an unusual proxy in front.
- **`TRUST_PROXY` unset**, so the app thinks the request is insecure. It
  defaults to 1, which is right for Railway.

### 403 "CSRF token missing or invalid"

The `mos_csrf` cookie is not coming back as the `x-csrf-token` header. This
works out of the box same-origin; it breaks if the API is served from a
different origin than the page. Keep them same-origin, or set `CORS_ORIGIN` to
the exact page origin.

### 429 Too Many Requests

Rate limiting is working. Defaults are 300 requests per 15 minutes per IP, and
tighter on login. Tune with `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MIN` rather
than removing the limiter.

### Uploaded images disappear after a deploy

No volume is attached. See step 3 — the container filesystem is replaced on
every deploy.

### AI writes generic copy

No `OPENAI_API_KEY` is set, so the built-in template engine is generating it.
This is intended and every result is labelled "Built-in engine" in the UI. Add
the key to switch to a model.

### Migrations

`prisma migrate deploy` applies committed migrations and never destroys data. If
it reports drift, the database was changed outside Prisma — resolve it
deliberately. **Never run `prisma migrate reset` on a live database**; there is
deliberately no npm script for it.

## Internal tooling

`tools/cli/` holds an earlier document-based planning CLI (`mos`) — quarterly
pacing, channel scorecards, a content-brief scaffolder. It is **not** part of the
product and nothing in the web application depends on it. Its own tests still
run with `node --test "tools/cli/test/*.test.js"`. The strategy documents that
came with it live in `docs/product/`.
