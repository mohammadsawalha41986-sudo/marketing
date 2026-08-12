# ICP and personas

The machine-readable version lives in [`data/icp.json`](../data/icp.json) and is
what campaigns reference by id. This document is the reasoning behind it.

## How we decide who is in

A segment earns a place here when it satisfies all four:

1. It has the pain, badly enough to have tried something already.
2. Someone in it owns a budget line that could pay for us.
3. We can reach it repeatably, at a cost we can afford.
4. We win there — evidenced, not assumed.

A segment that fails (4) after two quarters of real investment gets dropped, not
re-messaged.

## Segment 1 — Scaling operations team (`ops-scaleup`)

**Priority 1. Roughly 70% of pipeline should come from here.**

200–1500 employees, $30M–250M revenue, in logistics, healthcare services and
financial services. Growing headcount faster than process maturity.

### Who is in the room

| Role | Cares about | Wins when | Kills the deal when |
| --- | --- | --- | --- |
| VP Operations (economic buyer) | Cycle time, cost per transaction, headcount plan | They can show a number moved within a quarter | The business case rests on soft benefits |
| Director of Business Systems (champion) | Not being the single point of failure | They stop being the bottleneck for every change | The tool needs a specialist they do not have |
| IT Security (blocker) | SSO, data residency, audit logs, vendor risk | The security review is boring | Anything is unclear about where data goes |

### What just happened when they show up

- Headcount grew and the process that worked at 40 people broke at 120.
- An internal automation build stalled when its owner moved teams.
- A new compliance requirement landed with an audit deadline attached.

### What they say

> "Every exception ends up in my inbox."

> "I cannot tell you our cycle time without asking someone to build a report."

> "We tried to build it ourselves. It works, but only one person understands it."

### Disqualifiers

Under 50 employees; no dedicated operations or business systems owner; shopping
for a general-purpose no-code builder.

## Segment 2 — Enterprise transformation program (`enterprise-transform`)

**Priority 2. Fewer, larger, slower. Roughly 25% of pipeline.**

1500+ employees, $250M+ revenue, in manufacturing, insurance and telecom, with a
funded multi-year transformation program.

### Who is in the room

| Role | Cares about | Wins when | Kills the deal when |
| --- | --- | --- | --- |
| COO / Chief Transformation Officer (economic buyer) | Program milestones they are personally measured on | We map to a milestone on their board slide | We look like a point tool |
| Program Director (champion) | Delivery risk | We de-risk a date they have already committed to | Our implementation adds a dependency |
| Enterprise Architecture (technical evaluator) | Fit with the reference architecture | We integrate rather than replace | We require an exception to standards |
| Procurement (blocker) | Terms, precedent, leverage | The paper is standard | We are the only vendor evaluated |

### Buying reality

Twelve to twenty weeks. Security review and procurement are the long poles, not
the product evaluation. Marketing's job here is air cover for the champion:
material they can forward without editing, and proof that survives an
architecture review.

### Disqualifiers

No executive sponsor; a mandated single-vendor stack with no exception path.

## Segment 3 — Systems integrator partner (`sysint-partner`)

**Priority 3. Leverage, not volume. Roughly 5% of direct pipeline, more
indirectly.**

Consultancies and managed service providers building an automation practice.
They are a channel, not an end customer: they buy a repeatable delivery kit and
resell the outcome. Measured on sourced pipeline rather than MQLs.

## Anti-personas

Real people who will engage with our content and never buy. Recognising them
early protects the funnel numbers:

- **The student or job seeker.** Downloads the benchmark report, cites it in a
  dissertation. Harmless; exclude from MQL counts.
- **The competitor's product manager.** Attends every webinar. Also harmless.
- **The single-team enthusiast.** Loves the product, has no budget and no
  mandate. Route to self-serve; do not spend sales time.

## Keeping this honest

Every quarter, before planning:

1. Pull closed-won and closed-lost, tag by segment.
2. Compare win rate and cycle time by segment against the priorities above.
3. Read ten lost-deal notes in full. Not a summary — the notes.
4. Change the priorities or change the plan. Leaving both unchanged while the
   data moves is the failure mode.
