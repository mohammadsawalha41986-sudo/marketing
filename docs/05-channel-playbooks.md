# Channel playbooks

One section per channel in [`data/channels.json`](../data/channels.json). Each
says what the channel is for, who owns it, how it is run, and the number that
decides whether it keeps its budget.

A channel that misses its exit criterion for two consecutive quarters gets its
budget reallocated. That is the point of writing the criterion down before the
quarter starts.

---

## Organic search (`organic-search`) — owner: Priya

**Job:** own the questions our buyer asks before they know vendors exist, and
convert the comparison queries of people already shopping.

**How it runs**

- Three tiers of page: problem-level explainers, comparison pages, and the
  benchmark data we publish annually.
- Every page targets one query with one intent. A page trying to serve both an
  explainer and a comparison serves neither.
- Refresh beats publish: an existing page that ranks 5–15 is worth more effort
  than a new one.
- Internal links added the day a page ships, not in a quarterly sweep.

**Do not**

- Publish for a keyword we cannot credibly own within two quarters.
- Chase volume in queries with no buying intent because the number looks good.

**Exit criterion:** cost per MQL under $200 and non-brand traffic growing
quarter over quarter.

---

## Paid search (`paid-search`) — owner: Alex

**Job:** capture demand that already exists. It does not create demand, and
budget added here when nobody is searching just raises the price we pay.

**How it runs**

- Three campaign groups: category terms, competitor terms, brand defence.
- Brand defence is a cost of doing business, reported separately so it does not
  flatter blended CAC.
- Every ad group has a matched landing page. Sending competitor traffic to the
  homepage wastes the click.
- Weekly negative keyword review. Monthly full search-term audit.

**Do not**

- Judge on cost per click or CTR. Judge on cost per MQL and pipeline.
- Bid on a competitor's brand in a market where we cannot substantiate the
  comparison.

**Exit criterion:** cost per MQL under $600 and pipeline ROI above 4x.

---

## Paid social (`paid-social`) — owner: Noor

**Job:** reach the buying committee before they search, and retarget the accounts
ABM has named.

**How it runs**

- Two motions only: cold reach against the ICP, and retargeting against site and
  content engagement.
- Creative is refreshed every three weeks. Fatigue shows up as CPM drift before
  it shows up in conversions.
- Offers are content, not demos. A demo ad to a cold audience buys expensive
  no-shows.

**Do not**

- Optimise for lead form volume. It fills the funnel with people who will never
  take a call.
- Run a creative nobody on the team would stop scrolling for.

**Exit criterion:** cost per MQL under $450 and pipeline ROI above 3x. *Currently
failing both — see the open decision in the weekly report.*

---

## Lifecycle email (`lifecycle-email`) — owner: Dana

**Job:** move people we already reached from interest to activation to expansion.
Cheapest pipeline in the mix, and the easiest to ruin by over-sending.

**How it runs**

- Four programmes: onboarding activation, nurture by segment, product
  announcements, and the monthly newsletter.
- One idea per send. One call to action per send.
- Frequency cap across all programmes: three per person per fortnight.
- Every send is measured to pipeline, not to opens. Open rate is not a result.

**Do not**

- Send to a list because a campaign needs numbers this week.
- Reuse a nurture sequence for a new segment without rewriting it.

**Exit criterion:** cost per MQL under $200 and unsubscribe rate under 0.4%.

---

## Events and field (`events`) — owner: Sam

**Job:** compress enterprise cycles by getting the buying committee in a room.
Lumpy by nature — it reads as behind between spikes, and that is expected, not a
problem to fix.

**How it runs**

- Three formats: our own summit, a small number of sponsored industry events, and
  executive dinners for named ABM accounts.
- Every event has a pre-event outreach list and a 48-hour follow-up plan before
  it is booked. An event without follow-up is a party.
- Sponsorships are bought for the attendee list, not the logo placement.

**Do not**

- Book an event because we did it last year.
- Count badge scans as MQLs.

**Exit criterion:** sourced and influenced pipeline above 3x total cost,
measured 90 days after the event, not on the day.

---

## Partnerships (`partnerships`) — owner: Sam

**Job:** reach buyers through people they already trust, and make our
integrations worth talking about.

**How it runs**

- Joint launches with integration partners: a shared post, a shared webinar, and
  a mutual customer story where one exists.
- SI partners get a delivery kit, not a logo page.
- Co-marketing effort is proportional to co-selling commitment. A partner who
  will not introduce us to a customer gets a listing, not a campaign.

**Do not**

- Announce an integration nobody has asked for.
- Count a partner's audience as reach without a click to prove it.

**Exit criterion:** partner-sourced pipeline above 4x cost, and at least four
joint launches per half.

---

## Budget reallocation

Reviewed monthly, decided in the quarterly planning session. The rule:

1. A channel failing its exit criterion for two quarters loses at least a third
   of its budget.
2. That budget moves to the channel with the best marginal pipeline ROI that can
   absorb it — not to the one with the best average, and not to whoever argues
   hardest.
3. Lumpy channels are judged on a trailing four-quarter basis, never mid-quarter.

Run `mos status` for the current picture. The channel scorecard there is the
input to this decision, and the exit criteria above are what turn it into an
answer.
