# Messaging framework

Everything external traces back to this file. If a claim is not here, it does not
go on a page, in an ad, or in a deck until it is added here with its proof.

## The hierarchy

```
Positioning statement          one, stable across the year
  └── Value pillars            three, stable across the quarter
        └── Claims             several per pillar, each with proof
              └── Copy         many, per channel and per asset
```

Copy is the only layer that should churn weekly. If claims churn weekly, the
product story is not settled and no amount of copywriting fixes it.

## Value pillars

### Pillar 1 — Ship process changes in days, not quarters

| Claim | Proof | Where it is strongest |
| --- | --- | --- |
| The team that owns the process edits it | Product: versioned editor with rollback | Website, demo |
| Median first workflow live in nine days | Onboarding cohort data, Q2 2026 | Sales, paid search landing pages |
| No certified consultant required | Pricing page: implementation is optional | Comparison pages |

**Do not say:** "no code". It sets an expectation of a toy and invites the wrong
comparison set.

### Pillar 2 — Governance that survives an audit

| Claim | Proof | Where it is strongest |
| --- | --- | --- |
| Every run is logged, attributable and replayable | Product: run history and audit export | Enterprise, security review |
| Audit prep drops from weeks to a report | Customer interviews, three named accounts | ABM, field events |
| Permissions map to the org, not to the tool | Product: SSO and role sync | Architecture review |

**Do not say:** "compliant" without naming the framework. Name SOC 2, HIPAA or
the specific control, or say nothing.

### Pillar 3 — Exceptions handled, not dropped

| Claim | Proof | Where it is strongest |
| --- | --- | --- |
| Edge cases route to a human with full context | Product: exception queues | Demo, webinars |
| Ops teams spend 41% of their time on exceptions | State of Operations 2026, n=1,204 | Content, PR, top of funnel |
| Escalations stop consuming senior time | Meridian case study | Case studies, sales |

## Message by audience

The pillars do not change. The order does.

| Audience | Lead with | Then | Rarely |
| --- | --- | --- | --- |
| VP Operations | Pillar 1 (speed) | Pillar 3 (exceptions) | Pillar 2 |
| Business Systems Director | Pillar 1 | Pillar 2 | Pillar 3 |
| IT Security | Pillar 2 | — | — |
| COO / transformation | Pillar 3 (risk) | Pillar 2 | Pillar 1 |
| SI partner | Pillar 1 (margin) | Pillar 2 | Pillar 3 |

## Objection handling

Written honestly, because the objection is usually correct about something.

| Objection | The honest answer |
| --- | --- |
| "We already own a process suite." | You probably keep it. We take the workflows it changes too slowly, and we integrate rather than rip out. |
| "We can build this internally." | You can. The question is whether this is the thing your engineers should be building for the next three years, and who owns it when they move teams. |
| "Our processes are too specialised." | Every process is specialised. What is common is the shape: intake, routing, exception, audit. Bring your ugliest workflow to the evaluation. |
| "How is this different from no-code?" | Governance and volume. No-code tools break when a workflow needs permissions, audit and 100k runs a month. |
| "This is expensive." | Compared with a spreadsheet, yes. Compared with two contractors and a stalled internal build, run the numbers with us. |

## Proof inventory

Every claim above must resolve to something in this list. When a proof point
expires — the customer churns, the data goes stale — every claim depending on it
is pulled the same day.

| Proof | Type | Source | Expires |
| --- | --- | --- | --- |
| Meridian: 38% cycle-time reduction | Customer | Signed case study | 2027-07-30 |
| Ops teams spend 41% of time on exceptions | Research | State of Operations 2026, n=1,204 | 2027-07-15 |
| Median first workflow live in nine days | Product data | Onboarding cohort, Q2 2026 | Refresh quarterly |

## Words we use, and words we do not

| Use | Instead of |
| --- | --- |
| Operations automation | Hyperautomation, digital transformation |
| Workflow | Flow, journey, process object |
| Exception | Edge case, failure |
| Team that owns the process | Business user, citizen developer |

Banned outright: *seamless*, *frictionless*, *revolutionary*, *game-changing*,
*best-in-class*, *leverage* as a verb, *unlock* as anything but a door.

## Review

Reviewed at the start of each quarter, and immediately when a launch changes what
the product does. Owner: product marketing.
