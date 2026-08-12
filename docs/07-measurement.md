# Measurement

What we count, how we count it, and what the numbers are allowed to be used for.

## Definitions

Ambiguity here is what produces two dashboards that disagree and a meeting spent
reconciling them. These definitions are the only ones used in `data/`.

| Term | Definition | Counted when |
| --- | --- | --- |
| **Visit** | A session on a marketing-owned property | Session starts |
| **MQL** | A person at an ICP-fit account who took a qualifying action | Action fires and account passes fit check |
| **SQL** | An MQL that sales accepted after a first conversation | Sales marks accepted |
| **Win** | A closed-won opportunity with a marketing touch in the attribution window | Opportunity closes |
| **Pipeline** | Opportunity value created, at the value recorded on the day it was created | Opportunity is created |
| **Spend** | Media, tooling, event and agency cost. Salaries excluded. | Invoice date, not payment date |

### Qualifying actions for MQL

Demo request, trial signup, benchmark report download, webinar attendance (not
registration), pricing page visit with an identified account. Nothing else. A
newsletter signup is not an MQL, however much it flatters the total.

### Fit check

Account matches a segment in [`data/icp.json`](../data/icp.json) on employee
count and industry, and does not match a disqualifier. Failing the fit check is
not a lead, it is a contact.

## Derived measures

| Measure | Formula | Read it as |
| --- | --- | --- |
| Cost per MQL | spend ÷ MQLs | Efficiency of demand capture |
| CAC | spend ÷ wins | What a customer costs in marketing spend alone |
| Pipeline ROI | pipeline ÷ spend | Pipeline generated per dollar |
| Visit → MQL | MQLs ÷ visits | Whether traffic is the right traffic |
| MQL → SQL | SQLs ÷ MQLs | Whether our MQL definition is honest |
| SQL → Win | wins ÷ SQLs | Mostly a sales measure; watch it for segment drift |

MQL → SQL is the health check on our own definition. When it drops, the usual
cause is not sales getting worse; it is marketing loosening what counts as an MQL
to make a number.

## Pacing

`mos status` compares actuals against a target straight-lined across the quarter:

```
expected = target × (days elapsed ÷ days in quarter)
```

| Status | Actual vs expected |
| --- | --- |
| Ahead | ≥ 105% |
| On track | 95–105% |
| At risk | 85–95% |
| Behind | < 85% |

**This is deliberately naive.** Straight-lining is wrong for anything lumpy: an
events channel with one big spend in month one and its conference in month three
will read "behind" for most of the quarter and finish fine. That is why the
channel scorecard shows every channel separately rather than a blended figure,
and why the events exit criterion is measured on a trailing four-quarter basis.

Do not fix a straight-line artefact by changing the target. Read the channel.

## Attribution

We use two views and never mix them in the same sentence.

- **First touch** for judging top-of-funnel channels. Which channel found this
  account?
- **Multi-touch (linear)** for budget decisions across the whole mix.

Neither is truth. Attribution is a way of arguing about budget with numbers
attached, and it is most wrong exactly where it matters most: enterprise deals
with twenty touches over five months. For those, the win/loss note is better
evidence than the model.

The attribution window is 90 days. Events are reviewed at 90 days after the
event, not on the day.

## What these numbers may not be used for

- **Individual performance review.** Channel performance is a property of the
  channel, the market and the product, not of the person who owns it. Using it
  otherwise guarantees the data gets gamed, and then nobody has data.
- **Claiming credit against sales.** Marketing-sourced and sales-sourced are the
  same pipeline seen from two chairs.
- **External statements.** Nothing here goes into a press release or an investor
  update without finance signing off on the definitions.

## Data hygiene

- Weekly actuals are added on Friday and validated with `mos validate`. Numbers
  arriving late are still recorded against the week they belong to, never the
  week they were entered.
- A correction to a past week is an edit to the row plus a line in the commit
  message saying what changed and why. The git history is the audit trail.
- If a number cannot be sourced, it does not go in. An empty cell is honest; a
  guess is not, and three weeks later nobody remembers which was which.

## Known gaps

Written down so nobody rediscovers them in a meeting:

- Dark social and word of mouth land in direct traffic and get no credit.
- Self-reported attribution on the demo form is not yet in `data/`.
- Influenced pipeline for events is tracked in the CRM but not modelled here.
- Brand search is counted as paid search, which flatters paid search and
  understates everything that created the demand.
