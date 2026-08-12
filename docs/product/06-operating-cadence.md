# Operating cadence

The rhythm the team runs on. The point of a fixed cadence is that decisions
happen on a schedule instead of whenever someone is anxious enough to call a
meeting.

## Weekly

### Monday — the review (45 minutes, whole team)

Run `mos report` on Monday morning. The generated file is the agenda; nobody
prepares slides.

1. **Where we stand** (5 min) — read the pacing table. No commentary on numbers
   that are on track.
2. **What needs a decision** (25 min) — the generated callouts, in order. Each
   one ends with a named owner and a date, or it is explicitly deferred.
3. **Late content** (10 min) — every late item gets a new date or is killed. An
   item that slips twice without being killed is a standing lie about capacity.
4. **Asks** (5 min) — what we need from product, sales or finance this week.

What this meeting is not: a status round. If a person's update is "still working
on it", it does not need saying out loud.

### Wednesday — content standup (15 minutes, content owners)

`mos calendar --weeks 2`. Blockers only. Anything needing more than two minutes
becomes a separate conversation with the two people who care.

### Friday — data update

Owners add their week's actuals to `data/metrics.json`, then run `mos validate`.
The week is not closed until validation is clean. This is 20 minutes of work and
it is what makes Monday's meeting possible.

## Monthly

### Channel review (60 minutes)

Each channel owner answers three questions against their exit criterion in the
[channel playbooks](05-channel-playbooks.md):

1. Are we passing the criterion? (from `mos status`)
2. What did we learn that we did not know last month?
3. What would we do with 20% more budget, and what would we cut with 20% less?

The third question is the useful one. An owner who cannot answer it does not
understand their channel yet.

### Content retrospective (45 minutes)

Look at everything published last month against its brief. Not "did it do well" —
**did it do what the brief said it would**. A piece that got traffic for the wrong
reason is a miss, because it will not repeat.

## Quarterly

### Planning (half a day, two weeks before the quarter starts)

Inputs, in order:

1. Closed-won and closed-lost by segment — does the ICP still hold?
2. Channel exit criteria — what gets more, what gets less, what stops.
3. Product roadmap — what launches, at what tier.
4. The number sales needs from marketing, and whether it is arithmetically
   possible with the budget on the table.

Outputs: updated `data/config.json` goals, updated `data/channels.json` budgets
and targets, campaign briefs for anything starting in the first month, and a
written list of what we are **not** doing.

That last list is the one people skip and the one that saves the quarter.

### Messaging review (90 minutes)

Reopen [positioning](01-positioning.md) and the
[messaging framework](03-messaging-framework.md). Check the proof inventory for
anything expired. Pull every claim that no longer has live evidence.

## Per launch

Driven by [`templates/launch-checklist.md`](../templates/launch-checklist.md),
scaffolded with `mos new launch <id>`. Three tiers:

| Tier | What it is | Lead time | Who runs it |
| --- | --- | --- | --- |
| 1 | Company moment | 6 weeks | Product marketing, full team |
| 2 | Notable feature | 3 weeks | Product marketing, two channels |
| 3 | Release note | 1 week | Whoever owns the surface |

Tier inflation is the standard failure. Most things are tier 3. Calling
everything tier 1 exhausts the team and trains the audience to ignore us.

## Roles

| Area | Owner | Decides |
| --- | --- | --- |
| Positioning and messaging | Product marketing | What we claim |
| Content calendar | Content lead | What ships and when |
| Channel budgets | Channel owners, ratified quarterly | How money is spent within a channel |
| Reallocation between channels | Quarterly planning | Which channel gets the money |
| Launch go/no-go | Launch lead | Whether it ships |
| Brand and voice | Social and brand | How it sounds |

One name per row. Two names means no owner.

## Meetings we deliberately do not have

- A daily standup. The Wednesday content standup covers the only work with
  genuine day-to-day dependencies.
- A weekly all-marketing status meeting on top of the Monday review.
- A campaign kickoff that repeats what the brief already says. Read the brief.
