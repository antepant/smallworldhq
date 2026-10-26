# SmallworldHQ — NHL stats prototype

A static site with three views:

- **Players**: stats and ice time (EV / PP / SH) for every skater, for the season, the last 14 days or the last 7 days, plus each player's current line and PP unit, and how many games their team plays in the next 7 and 14 days (Nx7 / Nx14). Pick a team to see its depth chart (lines, D pairs, PP units and goalies). Pick **Goalies** under Position for goalie stats (depth order, SV%, GAA, GSAx), also for the 7/14-day windows. Click any player or goalie, in the table or the depth chart, to open their game log with an ice-time-per-game chart; each game shows the line and PP unit the player had in it.
- **Teams**: standings and team stats. Click a team to see its schedule with the starting goalie for each game (confirmed for past games, probable for upcoming ones) and its goalie stats.
- **Schedule**: a heatmap of teams by dates. It's coloured by **busyness** by default (games in the next 7 days, red = few, green = many), or by **opponent softness** (points % or goals against per game, blended with last season). In softness mode a corner marker flags **rest edges**: the opponent played yesterday and the team didn't. Back-to-backs are counted too. Below it, the **schedule breakdown** covers 1–8 Monday–Sunday weeks (pick with the Weeks filter). Teams are sorted by total games, with home games, back-to-backs and a kafenatid-style day-by-day string: a digit is a game day (the date's last digit), bold orange is home, a dot is no game.

## Run it

```bash
python fetch/fetch_data.py
```

```bash
python -m http.server 8000 --directory site
```

Then open http://localhost:8000. You need Python 3.9+ and nothing else (standard library only).

The first fetch takes about a minute. Later runs are faster because finished-game boxscores and shift charts are cached in `fetch/cache/`.

## Where the data comes from

| Data | Source |
|---|---|
| Standings, schedules, boxscores | `api-web.nhle.com/v1` |
| Skater/goalie/team stats, TOI splits, shift charts | `api.nhle.com/stats/rest/en` |
| Probable starting goalies (upcoming games) | ESPN scoreboard API (`site.api.espn.com`) |
| Expected goals: xG, G−xG, xGF%, GSAx | [MoneyPuck.com](https://moneypuck.com/data.htm) CSV downloads |

Neither API is officially documented, so endpoints can change. MoneyPuck's data is free for **non-commercial use with credit** (the site footer credits it); commercial use needs their permission. The fetch only downloads the files listed on their data page, at most every 6 hours (`MP_MAX_AGE`). If MoneyPuck is unreachable, the xG fields are left empty and everything else still works. All fetching lives in `fetch/fetch_data.py`.

## How things are worked out

- **Lines and PP units** are rebuilt from shift charts. For each team's last 3 games we count how many seconds each forward trio and D pair spent together at 5v5, and each 5-man unit while up a man. For even-strength lines, the most recent game counts fully and older ones at ½ and ¼ weight. PP units come from the last game only, so changes show up straight away. If that game had almost no PP time, the latest game that did is used. The top combinations without overlapping players become F1–F4, D1–D3 and PP1–PP2. Only players who dressed in the last game are eligible. This shows what the coach has been using, not a projection like DailyFaceoff's.
- **Line and PP unit per game** (in the game log) use the same method on that one game's shift chart. Shift charts for all finished games are cached in `fetch/cache/`; one the NHL hasn't posted yet is retried on the next run.
- **Goalie depth** (G1–G3): goalies on the team's current roster (`/v1/roster/{team}/current`), ordered by starts in the last 10 games, then season starts. The next game's probable starter is marked.
- **Game logs** are built from the boxscores already cached for finished games, so they need no extra requests. They're written to `site/data/gamelogs.json`, which loads the first time you open a player.
- **Expected goals** come from MoneyPuck's game-by-game skater and goalie files, joined on NHL player and game IDs.
  - Players: xG and G−xG for the season and the 7/14-day windows. G−xG uses MoneyPuck's own goal count so both numbers cover the same games.
  - Player panel: xG and G−xG per game.
  - Teams: 5v5 xGF%, plus xGF and xGA per game in all situations.
  - Goalies: GSAx (goals saved above expected = xGA − GA), for the season and per game.
  - MoneyPuck updates nightly, so the latest games may not have xG yet; the Players page says which date it covers.
- **Starting goalies**: the boxscore's `starter` flag for finished games. For upcoming games, ESPN's "probables" for the next 7 days. Further out shows "TBD".
- **Opponent softness** is a z-score of the opponent's points % (or GA/GP) across the league. Each team's current numbers are blended with last season's, with last season counting as 20 games (`PRIOR_GAMES`), so early-season records don't swing the colours too much.
- **Rest edge**: the opponent played the day before and the team didn't. Teams on the second night of a back-to-back often start their backup goalie.
- **Last 7 / 14 days** stats use the stats API's `gameDate` filter, ending on the fetch date (`RECENT_WINDOWS` in `fetch/fetch_data.py`).

## Hosting on GitHub Pages

The workflow in `.github/workflows/update-site.yml` fetches the data on GitHub's servers and publishes `site/` to GitHub Pages, so your computer doesn't need to be on. The generated data (`site/data/`) and the cache (`fetch/cache/`) are not committed; the workflow builds them.

**When it updates.** GitHub wakes the workflow every 30 minutes. A quick check (`fetch/should_update.py`) reads today's NHL schedule and the live site's `data/meta.json`, and only runs the full update when:

- **pre-game:** it's within an hour of the day's first puck drop and the site hasn't been updated since that hour began, or
- **post-game:** every game of the day is final, at least 3 h 45 min have passed since the last puck drop (the feed has no end time, so that's ~2 h 45 min of game plus an hour), and the site hasn't been updated since.

Otherwise the check stops after a few seconds. Days without games get no update. GitHub's timer often runs 5–15 minutes late and can occasionally skip a run, so "an hour" is approximate. To test the check for any moment: `python fetch/should_update.py --now 2026-10-15T22:10:00Z`.

**One-time setup**

1. Create an empty **public** repository on GitHub, e.g. `smallworldhq` (no README or .gitignore, so it doesn't conflict). Pages on a private repo needs a paid plan.
2. Push this folder to it:
   ```bash
   git remote add origin https://github.com/<your-username>/smallworldhq.git
   ```
   ```bash
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Go to **Actions → Update site → Run workflow** for the first deploy (the timer only updates around game time). The site appears at `https://<your-username>.github.io/smallworldhq/`.

**Good to know**

- **Manual refresh:** Actions → Update site → Run workflow, any time.
- **Inactive repos:** GitHub turns off scheduled workflows after 60 days without repository activity (it emails first); re-enable it from the Actions tab.
- **Custom domain:** set a repository variable `SITE_URL` (e.g. `https://smallworldhq.com`) so the check can find `meta.json`.
- **Cost:** free for public repositories. Each update takes 1–2 minutes; each check a few seconds.

## Next steps

- Add projected lines from DailyFaceoff, after checking their terms of use.
- Add PK units, which can be built the same way as PP units.
