# Marketing OS

A marketing team's operating system, kept in git.

Strategy lives in markdown so it can be reviewed and argued with. Campaigns,
content and weekly numbers live in JSON so they can be validated and counted. A
small CLI turns the two into the weekly review and a dashboard.

The goal is that "what are we doing, why, and is it working" has one answer, and
that answer has a commit history.

```
$ mos status

ExampleCo — 2026-Q3  data through 2026-08-09 · day 40/92 (43%)

Goals
─────
Goal      Actual  Expected  Target  vs plan  Status
--------  ------  --------  ------  -------  --------
Pipeline  $1.99M    $1.83M  $4.20M      +9%  Ahead
MQLs         743       783   1,800      -5%  At risk
SQLs         185       183     420      +1%  On track
Wins          30        27      62     +11%  Ahead
```

## Quick start

Node 20 or later. No dependencies to install — everything uses the standard
library.

```bash
node bin/mos.js status      # quarter snapshot
node bin/mos.js validate    # check data/ holds together
node bin/mos.js calendar    # content calendar by week
node bin/mos.js report      # write reports/weekly-YYYY-MM-DD.md
node bin/mos.js build       # write dist/dashboard.html
npm test                    # 67 tests, no network
```

Open `dist/dashboard.html` in a browser. It is one self-contained file — no
server, no build step, no network requests — so it can be attached to an email or
dropped in a shared drive and it still works.

For a shorter command, `npm link` puts `mos` on your path.

## What is in here

```
docs/          Strategy. Written for humans, reviewed like code.
data/          The facts. Validated JSON, one file per collection.
templates/     Briefs and checklists, scaffolded by `mos new`.
briefs/        Filled-in briefs, one file per campaign or launch.
src/           The CLI, the report generator, the dashboard generator.
test/          Tests for all of it, including the committed data.
reports/       Generated weekly reports, kept as history.
dist/          Generated dashboard. Not committed.
```

[`briefs/campaigns/platform-3-launch.md`](briefs/campaigns/platform-3-launch.md)
is a worked example of a filled-in brief, including the part most briefs skip:
the number and the date at which the campaign gets called off.

### Docs

| Document | What it settles |
| --- | --- |
| [Positioning](docs/01-positioning.md) | Who we are for and what we are against |
| [ICP and personas](docs/02-icp-and-personas.md) | Who we sell to, and who we do not |
| [Messaging framework](docs/03-messaging-framework.md) | Every claim, with its proof |
| [Brand voice](docs/04-brand-voice.md) | How it sounds, with examples |
| [Channel playbooks](docs/05-channel-playbooks.md) | How each channel runs, and when it loses its budget |
| [Operating cadence](docs/06-operating-cadence.md) | The meetings, and the ones we refuse to have |
| [Measurement](docs/07-measurement.md) | What each number means and what it may not be used for |

### Data

| File | Holds |
| --- | --- |
| `config.json` | Company, quarter window, goals, team |
| `icp.json` | Segments, buying committees, disqualifiers |
| `channels.json` | Channels with budgets and targets |
| `campaigns.json` | Campaigns with windows, budgets and targets |
| `content.json` | The content calendar |
| `metrics.json` | Weekly actuals, one row per channel per week |

Everything references everything else by id, and `mos validate` proves the
references resolve. A campaign pointing at a channel that no longer exists is an
error, not a silently empty chart.

## The weekly loop

1. **Friday** — channel owners add their week to `data/metrics.json`, run
   `mos validate`, commit. The week is not closed until validation is clean.
2. **Monday** — run `mos report`. The generated markdown is the agenda for the
   review; nobody makes slides.
3. **Decide** — the report's "what needs a decision" section is generated from
   the pacing, not written by hand, so an uncomfortable number cannot be quietly
   left off the agenda.

Full detail in the [operating cadence](docs/06-operating-cadence.md).

## Commands

| Command | Does |
| --- | --- |
| `mos status` | Quarter pacing, channel scorecard, efficiency, what is late |
| `mos validate` | Schema, references, and sanity checks over `data/` |
| `mos calendar [--weeks n] [--owner id]` | Content by week, with late items and quiet weeks |
| `mos campaigns` | All campaigns |
| `mos campaign <id>` | One campaign and its content |
| `mos report` | Weekly markdown report |
| `mos build` | Self-contained HTML dashboard |
| `mos new campaign\|content\|launch <id>` | Scaffold a brief from `templates/` |

Useful flags: `--as-of YYYY-MM-DD` to reproduce any past week, `--json` for
machine-readable output, `--stdout` to skip writing a file, `--out <path>` to
choose one.

```bash
mos status --as-of 2026-07-19          # what we knew three weeks ago
mos calendar --weeks 8 --owner dana
mos new campaign holiday-push --title "Holiday Push" --owner noor
```

## Making it yours

The committed data describes **ExampleCo**, a fictional B2B software company. It
is there so every command produces real output on a fresh clone. To adopt this:

1. Edit `data/config.json` — company, quarter, goals, team.
2. Replace `data/channels.json` with your channels and budgets. Keep the totals
   equal to `config.goals`; `mos validate` warns when they drift apart.
3. Empty `data/campaigns.json`, `data/content.json` and `data/metrics.json`, then
   add your own. `mos new` scaffolds the briefs.
4. Work through `docs/` in order. Positioning first — everything downstream
   depends on it, and a messaging framework built on unsettled positioning has to
   be rewritten anyway.
5. Delete `test/data.test.js` assertions that are specific to the sample company,
   or better, rewrite them as the invariants you want held about your data.

The docs are opinionated on purpose. Disagreeing with them in a pull request is a
better use of a quarter than starting from a blank page.

## Design notes

**Why files instead of a tool.** Marketing strategy usually lives in a slide deck
that nobody opens after the quarter starts. Kept in git it gets reviewed, diffed,
and blamed — you can see when a claim entered the messaging framework and who
approved it.

**Why the pacing maths is naive.** `expected = target × elapsed` is wrong for
lumpy channels, and the [measurement doc](docs/07-measurement.md) says so plainly
rather than hiding it behind a smoothed curve. A number you understand the flaws
of beats a number you trust blindly.

**Why no dependencies.** This has to run in three years without a lockfile
archaeology session. Everything is standard-library Node and inline SVG.

**Why the dashboard is one file.** Distribution. A single HTML file with no
script tags and no external requests can be opened from anywhere by anyone,
including whoever inherits this repo.

## Tests

```bash
npm test
```

The suite covers date arithmetic across DST and leap years, funnel and pacing
maths at the boundaries, calendar views, every validation rule, the CLI end to
end, and the committed dataset itself — including that the report and the
dashboard never render `NaN` and that the dashboard requests nothing from the
network.
