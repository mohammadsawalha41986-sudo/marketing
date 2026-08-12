# Positioning

> Positioning is a decision, not a paragraph. This document records the decision
> and the reasoning, so that the next person to argue with it has to argue with
> the reasoning rather than the wording.

## The statement

For **operations leaders at companies growing faster than their processes**, who
are **routing critical work through spreadsheets, inboxes and Slack threads**,
**ExampleCo** is an **operations automation platform** that **turns the workflows
a team already runs into governed, observable systems in days rather than
quarters**.

Unlike **legacy process suites**, which require a consulting engagement to change
anything, ExampleCo **puts the change in the hands of the team that owns the
process**.

## The four inputs

Positioning is downstream of four things. When one of them changes, this
document is reopened.

### 1. Competitive alternatives

What the buyer does if we do not exist:

| Alternative | Why they choose it | Where it fails them |
| --- | --- | --- |
| Spreadsheets and Slack | Free, immediate, no approval needed | No audit trail; every exception is a manual escalation; knowledge lives with one person |
| Legacy process suites | Trusted by procurement, deep on compliance | Change requests take quarters; needs a certified consultant for anything non-trivial |
| Internal build | Full control, engineers already on staff | Competes with product roadmap; owner leaves and it rots |
| General-purpose no-code | Fast to start, cheap to try | Falls over on governance, permissions and volume |

The most common alternative is not a competitor. It is a spreadsheet plus a
person who remembers how it works. Messaging that only attacks named competitors
misses most of the market.

### 2. Differentiated capabilities

What we have that the alternatives do not:

- **Change without a consultant.** The team that owns a process edits it, with
  versioning and rollback.
- **Governance that survives audit.** Every run is logged, attributable and
  replayable, without a separate compliance project.
- **Exceptions as first-class.** Edge cases route to a human with full context
  instead of falling out of the system.

### 3. Value

What those capabilities produce, in the buyer's terms:

| Capability | Value | Evidence |
| --- | --- | --- |
| Change without a consultant | Process changes ship in days; the roadmap stops being a queue | Meridian: 38% cycle-time reduction in one quarter |
| Governance that survives audit | Audit prep drops from weeks to a report | Referenced in the State of Operations 2026 report |
| Exceptions as first-class | Escalations stop consuming senior time | Benchmark: 41% of ops time spent on exception handling |

Value claims without evidence in the right-hand column do not ship. If the
evidence is missing, the claim is a hypothesis, and it belongs in a test rather
than on the homepage.

### 4. Target segment

The segment that cares most about the value above is defined in
[`data/icp.json`](../data/icp.json) and described in
[ICP and personas](02-icp-and-personas.md). It is deliberately narrow: teams of
200–1500 with a named operations owner and a compliance obligation.

## What we are not

Saying this plainly prevents most bad-fit pipeline:

- Not a general-purpose no-code app builder.
- Not an RPA screen-scraper.
- Not a project management tool.
- Not for teams under 50 people without a dedicated process owner.

## Category

We enter the **operations automation** category rather than inventing one.
Creating a category is expensive and slow, and the budget line already exists
under a name buyers recognise. We compete for that line.

## How to tell this is drifting

Reopen this document when any of these show up:

- Sales decks in the wild contain claims that are not in this file.
- Win/loss notes cite a competitor that is not in the table above.
- More than a quarter of closed-won accounts fall outside the target segment.
- The product ships a capability that changes the differentiation table.

## Change log

| Date | Change | Why |
| --- | --- | --- |
| 2026-05-04 | Narrowed the segment from "all mid-market" to teams with a named ops owner | Win rate in accounts without one was under 8% |
