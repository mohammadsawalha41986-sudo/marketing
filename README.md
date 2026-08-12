# Marketing OS

An AI-powered, multi-tenant marketing management platform. One agency workspace,
many clients, each with its own Brand DNA, campaigns, content, approvals,
analytics and a branded client portal.

```
CLIENT → BRAND DNA → MEDIA → AI CONTENT → CAMPAIGN → APPROVAL
      → SCHEDULING → PUBLISHING → MONITORING → ANALYTICS → AI ANALYSIS → REPORT
```

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | React 18, Vite 6, TypeScript, Tailwind CSS, React Router, Recharts, Framer Motion |
| Backend | Node 20+, Express 4, TypeScript (ESM) |
| Database | PostgreSQL 16 via Prisma 6 |
| Validation | Zod, on every request body, query and path parameter |
| Auth | Opaque session tokens in HTTP-only cookies, Argon2id password hashing |
| AI | OpenAI through a backend service, with a built-in generator as fallback |
| Storage | Provider interface with a local-disk driver |

No Docker required. In production a **single Node process** serves both the API
and the built SPA, which is what makes this deployable to a Hostinger Node.js
app without a reverse proxy in front of two services.

## Quick start

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL and SESSION_SECRET
npx prisma migrate deploy
npm run db:seed               # optional: demo agency with four clients
npm run build
npm start                     # http://localhost:3000
```

For development with hot reload on both sides:

```bash
npm run dev                   # API on :3000, Vite on :5173
```

### Demo accounts

`npm run db:seed` creates one agency ("Northwind Collective") with four clients
across different verticals — a restaurant, a hotel, a retail store and a
D2C e-commerce brand — with 90 days of analytics. Password for all:
`Passw0rd!demo`

| Role | Email |
| --- | --- |
| Super Admin | `root@marketingos.example.com` |
| Agency Admin | `admin@northwind.example.com` |
| Agency Staff | `staff@northwind.example.com` |
| Client Admin | `owner@zaytoun.example.com` |
| Client User | `team@zaytoun.example.com` |

Other client portals: `owner@cedar-shore.example.com`,
`owner@atlas-outfitters.example.com`, `owner@lumen-skincare.example.com`.

## What is real, and what is not

Stated plainly, because "looks finished" and "is finished" are different things.

### Fully working against the database

Authentication and sessions · role-based access · tenant isolation · client CRUD
· Brand DNA · logo upload with colour extraction · palette approval · media
library · campaign CRUD · content CRUD · AI content generation · hashtag
generation · Arabic and English · content calendar with rescheduling · approval
workflow · notifications · analytics · report generation and export · client
portal · subscription plans and usage limits · Super Admin · audit log.

### Deliberately not pretending

- **Ad-platform integrations are architecture only.** Meta, TikTok, Snapchat,
  Google Ads, Google Business, LinkedIn and X each have an adapter behind a
  shared interface, with real routes, credential storage, connection status and
  UI. Every adapter currently returns **HTTP 501** naming the environment
  variables it needs. Nothing reports a connection that does not exist, and no
  metric is ever invented from a platform we are not connected to.
- **Publishing is not wired up.** Scheduling writes a calendar entry and sets
  status; it does not post to any network.
- **No payment provider.** Plans, subscriptions and limits are enforced by the
  application, but nothing has been charged and no card details are stored. The
  `Subscription` model carries a `providerRef` field for a provider to populate.
- **Analytics data is seeded, not fetched.** `AnalyticsSnapshot` rows come from
  the seed script. Every number in the UI is computed from those rows — none is
  hard-coded — but they describe a fictional company until a real integration
  fills the table.
- **Password reset issues a token but sends no email.** Outside production the
  token is returned in the response so the flow is testable; in production it is
  created and logged for the operator. Wire up a mail transport before relying on it.
- **AI falls back when no key is set.** Without `OPENAI_API_KEY` the built-in
  template engine writes the copy, and the UI labels it "Built-in engine" on
  every result. Set the key and the same endpoints call the model instead.

## Architecture

```
prisma/schema.prisma     25 models, the tenancy boundary is Organization → Client
server/src/
  env.ts                 Zod-validated config; refuses to boot on a bad one
  app.ts                 Express assembly (helmet, CORS, CSRF, rate limits, SPA)
  lib/scope.ts           ← the single place tenant access is decided
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
  routes/                pages for the agency, client portal and admin
```

### Tenant isolation

`Organization` is the tenant. Every tenant-owned row carries `organizationId`;
rows a client may see also carry `clientId`.

`server/src/lib/scope.ts` derives the access scope **only from the authenticated
session** — never from a body field, query parameter or header. A client user is
pinned to their own `clientId`, so naming another client's id returns 404 rather
than 403: the API does not confirm that the other record exists.

`SUPER_ADMIN` is scoped like an agency admin on the normal API. Cross-tenant
reach is granted only by `crossTenant()`, which only `/api/admin/*` calls.

### AI architecture

```
request → brand context assembled by the caller → AI service → provider
        → zod schema validation → forbidden-word scrub → result → user edits → save
```

The AI service has no database access and no Prisma client. It receives a plain
`BrandContext` object and returns validated structure. It cannot write records:
generation is a pure read, and the user saves the result through the normal
content endpoints after editing it.

For campaign analysis the model receives only figures already computed from
`AnalyticsSnapshot` rows, and the system prompt forbids stating any number not
present in that object. The fallback analyst is rule-based and quotes only the
figures it was handed. Output is labelled as recommendations everywhere it appears.

## API

| Prefix | Purpose |
| --- | --- |
| `/api/auth` | register, login, logout, me, change password, forgot/reset |
| `/api/users` | agency user management |
| `/api/clients` | client CRUD and per-client overview |
| `/api/brands` | Brand DNA, logo upload, palette suggest/approve |
| `/api/media` | upload, browse, retag, delete, storage usage |
| `/api/campaigns` | campaign CRUD, platform mix, per-campaign analytics |
| `/api/content` | content CRUD, AI generation, hashtags, submit, schedule |
| `/api/calendar` | month/week/day views, drag-to-reschedule |
| `/api/approvals` | review queue, decisions, comments |
| `/api/analytics` | dashboard, series, AI marketing analyst |
| `/api/reports` | generate, read, export as HTML or Markdown |
| `/api/notifications` | list, mark read |
| `/api/integrations` | adapter catalogue, connect, disconnect, sync |
| `/api/subscriptions` | plans, subscriptions, usage against limits |
| `/api/admin` | Super Admin only, the only cross-tenant surface |

## Routes

**Agency** `/app/dashboard` `/app/clients` `/app/clients/:id` `/app/brand`
`/app/media` `/app/content` `/app/content/:id` `/app/studio` `/app/campaigns`
`/app/campaigns/:id` `/app/calendar` `/app/analytics` `/app/reports`
`/app/reports/:id` `/app/approvals` `/app/notifications` `/app/integrations`
`/app/settings`

**Client portal** `/client/dashboard` `/client/campaigns` `/client/content`
`/client/approvals` `/client/calendar` `/client/analytics` `/client/reports`
`/client/brand`

**Super Admin** `/admin/dashboard` `/admin/clients` `/admin/users`
`/admin/plans` `/admin/subscriptions` `/admin/reports` `/admin/audit`
`/admin/settings`

**Public** `/login` `/register` `/forgot-password`

## Security

- Argon2id password hashing at OWASP-recommended parameters.
- Opaque 256-bit session tokens; only their SHA-256 hash is stored, so a database
  leak does not hand over live sessions.
- HTTP-only, SameSite=Lax cookies; `Secure` in production.
- Double-submit CSRF on every authenticated mutation.
- Rate limiting globally and tighter on credential endpoints.
- Zod validation on every input; tenant ids never taken from the client.
- Upload validation by MIME **and** magic number. SVG is rejected outright — it
  is an executable document and would be stored XSS.
- Uploads served with `nosniff` and a restrictive CSP.
- Helmet security headers, with a full CSP in production.
- Integration credentials are never included in any API projection.
- Deactivating a user or suspending a client deletes their sessions immediately.
- No secrets in the repository; `.env` is git-ignored and `.env.example` documents
  every variable.

## Internationalization

Arabic and English, with full RTL. The language switcher flips `dir` on `<html>`
immediately — no reload — and the choice is persisted. Layout uses logical
properties (`ms-`, `me-`, `start-`, `end-`) so it mirrors correctly. Numeric spans
are marked `dir="ltr"` so signs and currency symbols stay on the correct side.

Content is generated independently in either language: the AI writes native
Arabic marketing copy, not a translation of the English.

**Known gap:** notification and alert text generated server-side is English only.

## Theming

Dark, light and system, defaulting to premium dark. All colour is CSS custom
properties, so an approved client palette re-skins the entire application at
runtime — a client signing into their portal sees it in their own brand colours.

## Testing

```bash
npm run typecheck    # server + web
npm test             # 86 server tests against a real PostgreSQL database
npm run build        # production build of both
npm run verify       # all three
```

The tests run against real PostgreSQL, not a mock — a mocked Prisma client would
prove nothing about whether the queries are actually scoped. Coverage includes
authentication and sessions, CSRF, password reset single-use, role authorization,
**tenant isolation** (including cross-tenant access attempts by id), client and
campaign CRUD, the approval workflow, scheduling rules, calendar rescheduling,
report generation and export, analytics maths at the boundaries, AI generation
including forbidden-word scrubbing and Arabic output, upload validation
including a file that lies about its MIME type, and the integration adapters'
refusal to fake a connection.

Set `TEST_DATABASE_URL` to point the suite at a different database; it defaults
to `marketing_os_test`.

## Deploying to Hostinger

Hostinger's **Node.js App** hosting plus a **PostgreSQL** database.

**1. Create the database** in hPanel → Databases → PostgreSQL. Note the host,
port, database name, user and password.

**2. Create the Node.js app** in hPanel → Advanced → Node.js:

| Setting | Value |
| --- | --- |
| Node version | 20 or newer |
| Application root | your deploy directory |
| Application startup file | `server/dist/index.js` |
| Application mode | production |

**3. Upload the code** (Git deploy or File Manager). Do not upload `.env`,
`node_modules`, `web/dist` or `server/dist` — they are built on the server.

**4. Set environment variables** in the Node.js app panel, from `.env.example`.
At minimum:

```
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?schema=public
SESSION_SECRET=<48+ random characters>
APP_URL=https://your-domain.com
CORS_ORIGIN=https://your-domain.com
COOKIE_SECURE=true
TRUST_PROXY=1
STORAGE_LOCAL_DIR=./storage/uploads
```

Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

**5. Install, migrate and build** from the panel's terminal:

```bash
npm ci --omit=dev=false
npx prisma migrate deploy
npm run build
```

**6. Optionally seed demo data** — skip this for a real deployment:

```bash
npm run db:seed
```

**7. Start the app.** Restart it from the panel; `npm start` runs
`node server/dist/index.js`, which serves the API and the built SPA on `PORT`.

### Notes for production

- `STORAGE_LOCAL_DIR` must be on persistent storage and **outside the web root**.
  It is served through the app, not directly by the web server.
- Set `COOKIE_SECURE=true` — sessions will not work correctly over HTTPS without it.
- `TRUST_PROXY=1` is required for correct client IPs behind Hostinger's proxy,
  which rate limiting and the audit log depend on.
- Run `npx prisma migrate deploy` — never `migrate dev` — on a live database.
- Back up before every deployment that includes a migration.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` in production |
| `PORT` | no | Listen port, default 3000 |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `SESSION_SECRET` | yes | 32+ characters |
| `SESSION_TTL_HOURS` | no | Session lifetime, default 168 |
| `APP_URL` | no | Public URL |
| `CORS_ORIGIN` | no | Comma-separated allowed origins |
| `COOKIE_SECURE` | no | `true` when serving over HTTPS |
| `TRUST_PROXY` | no | Proxy hops in front of the app, default 1 |
| `OPENAI_API_KEY` | no | Enables the language model; falls back without it |
| `OPENAI_MODEL` | no | Default `gpt-4o-mini` |
| `STORAGE_DRIVER` | no | `local` |
| `STORAGE_LOCAL_DIR` | no | Upload directory |
| `MAX_UPLOAD_MB` | no | Per-file limit, default 25 |
| `RATE_LIMIT_WINDOW_MIN` | no | Default 15 |
| `RATE_LIMIT_MAX` | no | Requests per window, default 300 |

Ad-platform variables (`META_APP_ID`, `TIKTOK_APP_ID`, …) are listed in
`.env.example`. Setting them does not enable an integration on its own — the
adapters still need implementing.

## Remaining manual configuration

1. **`OPENAI_API_KEY`** to move from the built-in generator to a real model.
2. **A mail transport** for password reset and notification email.
3. **Ad-platform credentials and adapter implementations** — the interface,
   routes and UI are ready; `fetchMetrics` and `publish` are not.
4. **A payment provider** for subscription billing.
5. **A backup schedule** for the database and the uploads directory.

## Internal tooling

`tools/cli/` holds an earlier document-based planning CLI (`mos`) — quarterly
pacing, channel scorecards, a content-brief scaffolder. It is **not** part of the
product and nothing in the web application depends on it. Its own tests still
run with `node --test "tools/cli/test/*.test.js"`. The strategy documents that
came with it live in `docs/product/`.
