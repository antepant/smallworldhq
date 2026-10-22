"""Fetch NHL data and write static JSON files for the site.

Sources:
  - api-web.nhle.com  (standings, schedules, boxscores)
  - api.nhle.com/stats/rest  (skater/goalie/team summaries, TOI splits, shift charts)
  - site.api.espn.com  (probable starting goalies for upcoming games)

Usage:  python fetch/fetch_data.py [--season 20262027] [--days-ahead 7]
Output: site/data/{meta,teams,players,goalies,schedule,lines}.json
Completed-game boxscores and shift charts are cached in fetch/cache/ since they never change.
"""

import argparse
import collections
import csv
import datetime as dt
import io
import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data"
CACHE = ROOT / "fetch" / "cache"

WEB = "https://api-web.nhle.com/v1"
STATS = "https://api.nhle.com/stats/rest/en"
ESPN = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl"

# ESPN abbreviations that differ from the NHL's
ESPN_TO_NHL = {"LA": "LAK", "NJ": "NJD", "SJ": "SJS", "TB": "TBL", "UTAH": "UTA"}

# Weight (in games) given to last season's numbers when blending opponent strength.
# Early in the season a team's record is noisy, so last season fills the gap.
PRIOR_GAMES = 20

FINAL_STATES = ("OFF", "FINAL")


def get_json(url, cache_name=None, retries=3):
    if cache_name:
        path = CACHE / cache_name
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (nhl-stats-prototype)"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                raise
            print(f"  retry {url}: {e}")
            time.sleep(2 * (attempt + 1))
    time.sleep(0.1)  # be polite
    if cache_name:
        CACHE.mkdir(parents=True, exist_ok=True)
        (CACHE / cache_name).write_text(json.dumps(data), encoding="utf-8")
    return data


def stats_report(kind, report, season, exp=None):
    exp = exp or f"seasonId={season} and gameTypeId=2"
    url = f"{STATS}/{kind}/{report}?limit=-1&cayenneExp={urllib.parse.quote(exp)}"
    return get_json(url)["data"]


def default_season(today):
    start = today.year if today.month >= 8 else today.year - 1
    return start * 10000 + start + 1


def mmss(s):
    if not s:
        return None
    m, sec = s.split(":")
    return int(m) * 60 + int(sec)


# ---------------------------------------------------------------- teams


def fetch_teams(season):
    seasons = get_json(f"{WEB}/standings-season")["seasons"]
    by_id = {s["id"]: s for s in seasons}
    cur = get_json(f"{WEB}/standings/now")["standings"]
    prev_season = by_id.get(season - 10001)
    prev = get_json(f"{WEB}/standings/{prev_season['standingsEnd']}")["standings"] if prev_season else []
    prev_by = {s["teamAbbrev"]["default"]: s for s in prev}

    tricode = {t["id"]: t["triCode"] for t in get_json(f"{STATS}/team")["data"]}
    summary = {tricode[t["teamId"]]: t for t in stats_report("team", "summary", season)}

    teams = {}
    for s in cur:
        ab = s["teamAbbrev"]["default"]
        p = prev_by.get(ab, {})
        sm = summary.get(ab, {})
        gp = s["gamesPlayed"]
        prev_gp = p.get("gamesPlayed") or 0

        def blend(cur_val, prev_val):
            if not prev_gp or prev_val is None:
                return cur_val
            w = min(PRIOR_GAMES, prev_gp)
            return (gp * cur_val + w * prev_val) / (gp + w) if gp + w else prev_val

        pts = s["pointPctg"] if gp else 0.0
        ga = s["goalAgainst"] / gp if gp else 0.0
        prev_pts = p.get("pointPctg")
        prev_ga = p["goalAgainst"] / prev_gp if prev_gp else None
        teams[ab] = {
            "abbrev": ab,
            "name": s["teamName"]["default"],
            "logo": s["teamLogo"],
            "conference": s["conferenceName"],
            "division": s["divisionName"],
            "gp": gp, "w": s["wins"], "l": s["losses"], "otl": s["otLosses"],
            "pts": s["points"], "ptsPct": s["pointPctg"],
            "gf": s["goalFor"], "ga": s["goalAgainst"],
            "l10": f'{s["l10Wins"]}-{s["l10Losses"]}-{s["l10OtLosses"]}',
            "streak": f'{s.get("streakCode", "")}{s.get("streakCount", "")}',
            "ppPct": sm.get("powerPlayPct"), "pkPct": sm.get("penaltyKillPct"),
            "sfPerGame": sm.get("shotsForPerGame"), "saPerGame": sm.get("shotsAgainstPerGame"),
            "foPct": sm.get("faceoffWinPct"),
            "prevPtsPct": prev_pts,
            # Strength used for "how soft is the opposition" in the schedule view
            "strength": {
                "ptsPct": blend(pts, prev_pts) if gp else (prev_pts or 0.5),
                "gaPerGame": blend(ga, prev_ga) if gp else (prev_ga or 3.0),
            },
        }
    return teams


# ---------------------------------------------------------------- players


# Rolling windows (in days, ending today) offered alongside season totals on the Players page
RECENT_WINDOWS = (7, 14)


def skater_rows(season, exp=None):
    summary = stats_report("skater", "summary", season, exp)
    toi = {r["playerId"]: r for r in stats_report("skater", "timeonice", season, exp)}
    players = []
    for r in summary:
        t = toi.get(r["playerId"], {})
        players.append({
            "id": r["playerId"],
            "name": r["skaterFullName"],
            "team": (r.get("teamAbbrevs") or "").split(",")[-1],  # traded players: current team last
            "pos": r["positionCode"],
            "gp": r["gamesPlayed"], "g": r["goals"], "a": r["assists"], "p": r["points"],
            "pm": r["plusMinus"], "pim": r["penaltyMinutes"], "sog": r["shots"],
            "ppp": r["ppPoints"], "shp": r["shPoints"],
            "toi": r.get("timeOnIcePerGame"),
            "evToi": t.get("evTimeOnIcePerGame"),
            "ppToi": t.get("ppTimeOnIcePerGame"),
            "shToi": t.get("shTimeOnIcePerGame"),
            "shifts": t.get("shiftsPerGame"),
        })
    return players


def fetch_players(season, today):
    players = skater_rows(season)
    recent = {}
    for days in RECENT_WINDOWS:
        start = today - dt.timedelta(days=days)
        exp = f'gameDate>="{start}" and gameDate<="{today}" and gameTypeId=2'
        stat_keys = ("gp", "g", "a", "p", "pm", "pim", "sog", "ppp", "shp", "toi", "evToi", "ppToi", "shToi", "shifts")
        recent[str(days)] = {"from": str(start), "to": str(today),
                             "players": {r["id"]: {k: r[k] for k in stat_keys} for r in skater_rows(season, exp)}}
    goalies = goalie_rows(season)
    goalie_keys = ("gp", "gs", "w", "l", "otl", "svPct", "gaa", "so", "sa", "sv", "ga")
    for days in RECENT_WINDOWS:
        win = recent[str(days)]
        exp = f'gameDate>="{win["from"]}" and gameDate<="{win["to"]}" and gameTypeId=2'
        win["goalies"] = {r["id"]: {k: r[k] for k in goalie_keys} for r in goalie_rows(season, exp)}
    return players, recent, goalies


def goalie_rows(season, exp=None):
    return [{
        "id": r["playerId"], "name": r["goalieFullName"],
        "team": (r.get("teamAbbrevs") or "").split(",")[-1],
        "gp": r["gamesPlayed"], "gs": r["gamesStarted"], "w": r["wins"], "l": r["losses"],
        "otl": r["otLosses"], "svPct": r["savePct"], "gaa": r["goalsAgainstAverage"], "so": r["shutouts"],
        "sa": r.get("shotsAgainst"), "sv": r.get("saves"), "ga": r.get("goalsAgainst"),
    } for r in stats_report("goalie", "summary", season, exp)]


# ---------------------------------------------------------------- schedule + goalies


def fetch_schedule(season, team_abbrevs):
    games = {}
    for ab in team_abbrevs:
        for g in get_json(f"{WEB}/club-schedule-season/{ab}/{season}")["games"]:
            if g["gameType"] != 2 or g["id"] in games:
                continue
            games[g["id"]] = {
                "id": g["id"],
                "date": g["gameDate"],
                "startUTC": g["startTimeUTC"],
                "home": g["homeTeam"]["abbrev"],
                "away": g["awayTeam"]["abbrev"],
                "state": g["gameState"],
                "homeScore": g["homeTeam"].get("score"),
                "awayScore": g["awayTeam"].get("score"),
                "lastPeriod": (g.get("gameOutcome") or {}).get("lastPeriodType"),
                "homeGoalie": None, "awayGoalie": None,
            }
    return sorted(games.values(), key=lambda g: g["startUTC"])


def boxscore(game_id, final):
    url = f"{WEB}/gamecenter/{game_id}/boxscore"
    return get_json(url, f"box_{game_id}.json" if final else None)


def add_confirmed_goalies(games):
    """Completed games: the boxscore flags the goalie who started."""
    for g in games:
        if g["state"] not in FINAL_STATES:
            continue
        box = boxscore(g["id"], True)
        for side, key in (("homeTeam", "homeGoalie"), ("awayTeam", "awayGoalie")):
            for gk in box["playerByGameStats"][side]["goalies"]:
                if gk.get("starter"):
                    g[key] = {"id": gk["playerId"], "name": gk["name"]["default"],
                              "sv": gk.get("saveShotsAgainst"), "status": "confirmed"}


def add_probable_goalies(games, days_ahead):
    """Upcoming games: ESPN's scoreboard lists probable starters."""
    today = dt.date.today()
    upcoming = [g for g in games if g["state"] not in FINAL_STATES]
    for i in range(days_ahead + 1):
        day = today + dt.timedelta(days=i)
        try:
            events = get_json(f"{ESPN}/scoreboard?dates={day:%Y%m%d}").get("events", [])
        except Exception as e:  # ESPN is optional; the site still works without it
            print(f"  ESPN {day}: {e}")
            continue
        for ev in events:
            comp = ev["competitions"][0]
            sides = {}
            for c in comp["competitors"]:
                ab = c["team"]["abbreviation"]
                prob = (c.get("probables") or [{}])[0].get("athlete", {}).get("displayName")
                sides[c["homeAway"]] = (ESPN_TO_NHL.get(ab, ab), prob)
            if "home" not in sides or "away" not in sides:
                continue
            start = dt.datetime.fromisoformat(comp["date"].replace("Z", "+00:00"))
            for g in upcoming:
                if g["home"] != sides["home"][0] or g["away"] != sides["away"][0]:
                    continue
                gstart = dt.datetime.fromisoformat(g["startUTC"].replace("Z", "+00:00"))
                if abs((gstart - start).total_seconds()) > 12 * 3600:
                    continue
                for side, key in (("home", "homeGoalie"), ("away", "awayGoalie")):
                    name = sides[side][1]
                    if name and not g[key]:
                        g[key] = {"id": None, "name": name, "sv": None, "status": "probable"}


# ---------------------------------------------------------------- lines from shift charts


def count_units(game_id, team):
    """Seconds each forward trio / D pair (5v5) and 5-man PP unit spent together in one game."""
    box = boxscore(game_id, True)
    side = "homeTeam" if box["homeTeam"]["abbrev"] == team else "awayTeam"
    other = "awayTeam" if side == "homeTeam" else "homeTeam"
    pos = {}
    for s in (side, other):
        for grp, code in (("forwards", "F"), ("defense", "D"), ("goalies", "G")):
            for p in box["playerByGameStats"][s][grp]:
                pos[p["playerId"]] = code
    us = {p["playerId"] for grp in ("forwards", "defense") for p in box["playerByGameStats"][side][grp]}

    shifts = get_json(f"{STATS}/shiftcharts?cayenneExp=gameId={game_id}", f"shifts_{game_id}.json")["data"]
    if not shifts:  # the NHL sometimes posts shift charts a while after the game; try again next run
        (CACHE / f"shifts_{game_id}.json").unlink(missing_ok=True)
    on_us = collections.defaultdict(set)
    n_them = collections.Counter()
    for r in shifts:
        if r.get("typeCode") != 517 or pos.get(r["playerId"]) in (None, "G"):
            continue
        a, b = mmss(r.get("startTime")), mmss(r.get("endTime"))
        if a is None or b is None or b <= a:
            continue
        base = (r["period"] - 1) * 1200
        for t in range(base + a, base + b):
            if r["playerId"] in us:
                on_us[t].add(r["playerId"])
            else:
                n_them[t] += 1

    trios, pairs, pp = collections.Counter(), collections.Counter(), collections.Counter()
    for t, skaters in on_us.items():
        n_us = len(skaters)
        if n_us == 5 and n_them[t] == 5:
            fw = frozenset(p for p in skaters if pos[p] == "F")
            d = frozenset(p for p in skaters if pos[p] == "D")
            if len(fw) == 3:
                trios[fw] += 1
            if len(d) == 2:
                pairs[d] += 1
        elif n_us == 5 and n_them[t] in (3, 4):
            pp[frozenset(skaters)] += 1

    dressed_f = {p["playerId"] for p in box["playerByGameStats"][side]["forwards"]}
    dressed_d = {p["playerId"] for p in box["playerByGameStats"][side]["defense"]}
    return trios, pairs, pp, dressed_f, dressed_d


# Most recent game counts fully, older games less: lines change, but one game is noisy.
LINE_GAME_WEIGHTS = (1.0, 0.5, 0.25)


def derive_lines(game_ids, team):
    """Rebuild a team's current lines from its last few shift charts (most recent first).

    Even strength: the forward trios / defence pairs that spent the most 5v5 time together,
                   weighted over the last few games.
    Power play:    the 5-skater units most often on the ice while up a man, from the most
                   recent game only (so PP changes show up straight away). If that game had
                   almost no PP time, the latest game that did is used instead.
    Only players who dressed in the most recent game are eligible.
    """
    trios, pairs = collections.Counter(), collections.Counter()
    pp, pp_game = None, None
    dressed_f = dressed_d = None
    for gid, w in zip(game_ids, LINE_GAME_WEIGHTS):
        t, d, u, df, dd = count_units(gid, team)
        if dressed_f is None:
            dressed_f, dressed_d = df, dd
        for src, dst in ((t, trios), (d, pairs)):
            for k, v in src.items():
                dst[k] += v * w
        if pp is None and sum(u.values()) >= 60:
            pp, pp_game = u, gid
    forwards, defense, pp_units = assign_units(trios, pairs, pp or collections.Counter(), dressed_f, dressed_d)

    def fmt(groups):
        return [{"players": sorted(c), "sec": round(s)} for c, s in groups]

    return {
        "gameIds": list(game_ids),
        "forwards": fmt(forwards),
        "defense": fmt(defense),
        "pp": fmt(pp_units),
        "ppGameId": pp_game,
    }


def assign_units(trios, pairs, pp, dressed_f, dressed_d):
    """Pick F1-F4, D1-D3 and PP1-PP2 from seconds-together counters. Returns lists of (players, seconds)."""
    dressed = dressed_f | dressed_d

    def greedy(counter, n, pool, size, min_sec=20):
        picked, used = [], set()
        for combo, sec in counter.most_common():
            if len(picked) == n:
                break
            if sec < min_sec or combo & used or not combo <= pool:
                continue
            picked.append((combo, sec))
            used |= combo
        # Fill a missing last unit with whoever dressed but wasn't placed
        # (may be short, e.g. two leftover forwards in an 11F/7D lineup)
        left = pool - used
        if len(picked) < n and left:
            combo = frozenset(sorted(left, key=lambda p: -sum(v for c, v in counter.items() if p in c))[:size])
            picked.append((combo, counter.get(combo, 0)))
        return picked

    # PP units may share a player (often a defenceman), so allow overlap of one
    pp_units = []
    for combo, sec in pp.most_common():
        if len(pp_units) == 2 or sec < 10:
            break
        if combo <= dressed and all(len(combo & u) <= 1 for u, _ in pp_units):
            pp_units.append((combo, sec))
    return greedy(trios, 4, dressed_f, 3), greedy(pairs, 3, dressed_d, 2), pp_units


def game_roles(game):
    """playerId -> (line, PP unit) for one finished game, e.g. ("F2", "PP1") or ("D1", None)."""
    roles = {}
    for team in (game["home"], game["away"]):
        trios, pairs, pp, dressed_f, dressed_d = count_units(game["id"], team)
        if not trios and not pairs:
            continue  # no shift chart yet
        forwards, defense, pp_units = assign_units(trios, pairs, pp, dressed_f, dressed_d)
        for prefix, groups in (("F", forwards), ("D", defense)):
            for i, (combo, _) in enumerate(groups, 1):
                for pid in combo:
                    roles[pid] = (f"{prefix}{i}", None)
        for i, (combo, _) in enumerate(pp_units, 1):
            for pid in combo:
                line = roles.get(pid, (None, None))[0]
                if roles.get(pid, (None, None))[1] is None:
                    roles[pid] = (line, f"PP{i}")
    return roles


def fetch_lines(games, team_abbrevs):
    recent = collections.defaultdict(list)
    for g in games:
        if g["state"] in FINAL_STATES:
            recent[g["home"]].append(g)
            recent[g["away"]].append(g)
    lines = {}
    for ab in team_abbrevs:
        played = recent.get(ab)
        if not played:
            continue
        last = played[::-1][:len(LINE_GAME_WEIGHTS)]
        try:
            lines[ab] = derive_lines([g["id"] for g in last], ab) | {
                "date": last[0]["date"], "opp": last[0]["away"] if last[0]["home"] == ab else last[0]["home"]}
        except Exception as e:
            print(f"  lines {ab}: {e}")
    return lines


def goalie_depth(games, goalie_stats, team_abbrevs, recent_n=10):
    """Order each team's rostered goalies by starts in its last `recent_n` games, then season starts."""
    stats = {g["id"]: g for g in goalie_stats}
    depth = {}
    for ab in team_abbrevs:
        played = [g for g in games if g["state"] in FINAL_STATES and ab in (g["home"], g["away"])]
        recent = collections.Counter()
        for g in played[-recent_n:]:
            gk = g["homeGoalie"] if g["home"] == ab else g["awayGoalie"]
            if gk:
                recent[gk["id"]] += 1
        nxt = next((g for g in games if g["state"] not in FINAL_STATES and ab in (g["home"], g["away"])), None)
        nxt_gk = (nxt["homeGoalie"] if nxt["home"] == ab else nxt["awayGoalie"]) if nxt else None
        roster = get_json(f"{WEB}/roster/{ab}/current").get("goalies", [])
        rows = []
        for r in roster:
            s = stats.get(r["id"], {})
            name = f'{r["firstName"]["default"]} {r["lastName"]["default"]}'
            rows.append({
                "id": r["id"], "name": name, "number": r.get("sweaterNumber"),
                "recentStarts": recent[r["id"]], "recentGames": min(recent_n, len(played)),
                "gp": s.get("gp", 0), "gs": s.get("gs", 0), "w": s.get("w", 0), "l": s.get("l", 0),
                "otl": s.get("otl", 0), "svPct": s.get("svPct"), "gaa": s.get("gaa"),
                "nextProbable": bool(nxt_gk and nxt_gk["name"] == name),
            })
        rows.sort(key=lambda r: (-r["recentStarts"], -r["gs"], -r["gp"]))
        depth[ab] = {"goalies": rows,
                     "next": {"date": nxt["date"], "opp": nxt["away"] if nxt["home"] == ab else nxt["home"],
                              "home": nxt["home"] == ab, "goalie": nxt_gk} if nxt else None}
    return depth


SKATER_LOG_COLS = ["gameId", "side", "g", "a", "p", "pm", "pim", "sog", "hits", "blk", "ppg", "toi", "shifts", "fo",
                   "evToi", "ppToi", "shToi", "line", "ppUnit"]
GOALIE_LOG_COLS = ["gameId", "side", "starter", "decision", "toi", "sa", "sv", "ga", "evGa", "ppGa"]


def per_game_toi(games):
    """(playerId, gameId) -> (EV, PP, SH) seconds, from the stats API's per-game TOI report.

    Fetched one game date at a time; dates whose games are all finished are cached.
    """
    by_date = collections.defaultdict(list)
    for g in games:
        by_date[g["date"]].append(g)
    out = {}
    for day, gs in sorted(by_date.items()):
        done = [g for g in gs if g["state"] in FINAL_STATES]
        if not done:
            continue
        exp = urllib.parse.quote(f'gameDate="{day}" and gameTypeId=2')
        url = f"{STATS}/skater/timeonice?isGame=true&limit=-1&cayenneExp={exp}"
        rows = get_json(url, f"toi_{day}.json" if len(done) == len(gs) else None)["data"]
        for r in rows:
            out[(r["playerId"], r["gameId"])] = (r.get("evTimeOnIce"), r.get("ppTimeOnIce"), r.get("shTimeOnIce"))
    return out


def build_gamelogs(games):
    """Per-player game logs from (cached) boxscores of finished games, stored as compact rows."""
    toi_split = per_game_toi(games)
    skaters, goalies = collections.defaultdict(list), collections.defaultdict(list)
    for g in games:
        if g["state"] not in FINAL_STATES:
            continue
        box = boxscore(g["id"], True)
        roles = game_roles(g)
        for side, flag in (("homeTeam", "h"), ("awayTeam", "a")):
            pg = box["playerByGameStats"][side]
            for p in pg["forwards"] + pg["defense"]:
                skaters[p["playerId"]].append([
                    g["id"], flag, p["goals"], p["assists"], p["points"], p["plusMinus"], p["pim"],
                    p["sog"], p["hits"], p["blockedShots"], p["powerPlayGoals"], mmss(p["toi"]),
                    p["shifts"], round(p["faceoffWinningPctg"], 3) if p.get("faceoffWinningPctg") else None,
                    *toi_split.get((p["playerId"], g["id"]), (None, None, None)),
                    *roles.get(p["playerId"], (None, None))])
            for p in pg["goalies"]:
                if not mmss(p.get("toi")):
                    continue  # dressed as backup, didn't play
                goalies[p["playerId"]].append([
                    g["id"], flag, 1 if p.get("starter") else 0, p.get("decision"), mmss(p["toi"]),
                    p.get("shotsAgainst"), p.get("saves"), p.get("goalsAgainst"),
                    p.get("evenStrengthGoalsAgainst"), p.get("powerPlayGoalsAgainst")])
    return {"skaterCols": SKATER_LOG_COLS, "goalieCols": GOALIE_LOG_COLS,
            "skaters": skaters, "goalies": goalies}


def player_labels(lines):
    labels = {}
    for ab, ln in lines.items():
        for kind, prefix in (("forwards", "F"), ("defense", "D")):
            for i, grp in enumerate(ln[kind], 1):
                for p in grp["players"]:
                    labels.setdefault(p, {})["line"] = f"{prefix}{i}"
        for i, grp in enumerate(ln["pp"], 1):
            for p in grp["players"]:
                labels.setdefault(p, {}).setdefault("pp", f"PP{i}")
    return labels


# ---------------------------------------------------------------- main


# ---------------------------------------------------------------- Terrier starting value (TSV)
#
# players.txt (project root) is a static, tab-separated price list ("$" column) with names as
# "first initial + surname". Each site skater gets the price of its match, or 0 without one.
# Players in the list that aren't on the site are ignored.

TSV_FILE = ROOT / "players.txt"
TSV_TEAM_FIX = {"CAL": "CGY"}
# Same initial, surname, team and position in the list, so the file alone can't tell them apart
TSV_OVERRIDES = {"Albert Johansson": 1.08, "Anton Johansson": 0.50}


def _fold(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z ]", "", s.replace("-", " ")).split()


def _fix_mojibake(s):
    # Some names were saved as UTF-8 read as Latin-1 ("LafreniÃ¨re" for "Lafrenière")
    try:
        return s.encode("latin-1").decode("utf-8") if "Ã" in s else s
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def load_tsv_list():
    rows = []
    if not TSV_FILE.exists():
        return rows
    for line in TSV_FILE.read_text(encoding="utf-8-sig").splitlines()[1:]:
        f = line.split("\t")
        while f and not f[0].strip():
            f.pop(0)  # some lines start with a stray tab
        if len(f) < 4:
            continue
        try:
            price = float(f[3])
        except ValueError:
            continue
        initial, _, last = _fix_mojibake(f[0].strip()).partition(" ")
        rows.append({"ini": "".join(_fold(initial))[:1], "last": _fold(last), "team": TSV_TEAM_FIX.get(f[2], f[2]),
                     "fwd": f[1] in ("C", "W"), "goalie": f[1] == "G", "tsv": price})
    return rows


def add_tsv(players, goalies):
    """Set p["tsv"] for every skater and goalie: initial + surname (full or last word), then team, then F/D."""
    rows = load_tsv_list()
    for g in goalies:
        g["pos"] = "G"
    matched = 0
    for p in players + goalies:
        if p["name"] in TSV_OVERRIDES:
            p["tsv"] = TSV_OVERRIDES[p["name"]]
            matched += 1
            continue
        first, _, last = p["name"].partition(" ")
        ini, surname = "".join(_fold(first))[:1], _fold(last)
        cands = [r for r in rows if r["goalie"] == (p["pos"] == "G") and r["ini"] == ini and surname
                 and (r["last"] == surname or r["last"] == surname[-1:])]
        for narrow in (lambda r: r["team"] == p["team"], lambda r: r["fwd"] == (p["pos"] != "D")):
            if len(cands) > 1 and any(narrow(r) for r in cands):
                cands = [r for r in cands if narrow(r)]
        p["tsv"] = cands[0]["tsv"] if len(cands) == 1 else 0
        matched += len(cands) == 1
    print(f"  TSV: {matched} of {len(players) + len(goalies)} skaters and goalies matched in {TSV_FILE.name}")


# ---------------------------------------------------------------- MoneyPuck expected goals
#
# MoneyPuck's downloadable CSVs are free for non-commercial use with credit to MoneyPuck.com
# (https://moneypuck.com/data.htm). We only use the files listed on that page, at most once
# every few hours; they are updated nightly.

MP_SEASON = "https://moneypuck.com/moneypuck/playerData/seasonSummary/{year}/regular/{kind}.csv"
MP_GAMES = "https://peter-tanner.com/moneypuck/downloads/seasonPlayersSummary/{kind}/{year}.zip"
MP_MAX_AGE = 6 * 3600


def mp_download(url, name):
    path = CACHE / "moneypuck" / name
    if path.exists() and time.time() - path.stat().st_mtime < MP_MAX_AGE:
        return path.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (nhl-stats-prototype)"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def mp_rows(url, name, situation="all"):
    data = mp_download(url, name)
    if name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            data = zf.read(zf.namelist()[0])
    return [r for r in csv.DictReader(io.StringIO(data.decode("utf-8"))) if r["situation"] == situation]


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def fetch_moneypuck(season, recent):
    """Expected goals per player-game, per team and per goalie.

    Returns (skater_games, goalie_games, skater_totals, team_xg, goalie_xg, through):
      skater_games[(pid, gameId)] = xG          goalie_games[(pid, gameId)] = (xGA, GA)
      skater_totals[window][pid]  = {xg, mpG}   window is "season" or a RECENT_WINDOWS key
    """
    year = season // 10000
    sk = mp_rows(MP_GAMES.format(kind="skaters", year=year), f"games_skaters_{year}.zip")
    gk = mp_rows(MP_GAMES.format(kind="goalies", year=year), f"games_goalies_{year}.zip")
    through = max((r["gameDate"] for r in sk), default=None)

    skater_games = {}
    windows = {"season": (None, None)} | {k: (v["from"].replace("-", ""), v["to"].replace("-", "")) for k, v in recent.items()}
    totals = {w: collections.defaultdict(lambda: {"xg": 0.0, "mpG": 0}) for w in windows}
    for r in sk:
        pid, gid, xg, g = int(r["playerId"]), int(r["gameId"]), fnum(r["I_F_xGoals"]) or 0.0, int(fnum(r["I_F_goals"]) or 0)
        skater_games[(pid, gid)] = round(xg, 2)
        for w, (lo, hi) in windows.items():
            if lo is None or lo <= r["gameDate"] <= hi:
                totals[w][pid]["xg"] += xg
                totals[w][pid]["mpG"] += g
    goalie_games = {(int(r["playerId"]), int(r["gameId"])): (round(fnum(r["xGoals"]) or 0.0, 2), int(fnum(r["goals"]) or 0)) for r in gk}
    gk_totals = {w: collections.defaultdict(lambda: {"xga": 0.0, "ga": 0}) for w in windows}
    for r in gk:
        for w, (lo, hi) in windows.items():
            if lo is None or lo <= r["gameDate"] <= hi:
                gk_totals[w][int(r["playerId"])]["xga"] += fnum(r["xGoals"]) or 0.0
                gk_totals[w][int(r["playerId"])]["ga"] += int(fnum(r["goals"]) or 0)
    totals["goalies"] = gk_totals

    teams_5v5 = {r["team"]: r for r in mp_rows(MP_SEASON.format(year=year, kind="teams"), f"teams_{year}.csv", "5on5")}
    team_xg = {}
    for r in mp_rows(MP_SEASON.format(year=year, kind="teams"), f"teams_{year}.csv"):
        gp = fnum(r["games_played"]) or 0
        five = teams_5v5.get(r["team"], {})
        team_xg[r["team"]] = {
            "xgfPct": fnum(five.get("xGoalsPercentage")),
            "xgfPerGame": fnum(r["xGoalsFor"]) / gp if gp else None,
            "xgaPerGame": fnum(r["xGoalsAgainst"]) / gp if gp else None,
        }
    goalie_xg = {}
    for r in mp_rows(MP_SEASON.format(year=year, kind="goalies"), f"goalies_{year}.csv"):
        xga, ga = fnum(r["xGoals"]), fnum(r["goals"])
        goalie_xg[int(r["playerId"])] = {"xga": xga, "gsax": round(xga - ga, 2) if xga is not None and ga is not None else None}
    return skater_games, goalie_games, totals, team_xg, goalie_xg, through


def add_xg(season, players, recent, teams, goalies, gamelogs):
    """Merge MoneyPuck xG into the NHL-based records. Missing MoneyPuck data leaves fields null."""
    try:
        sk_games, gk_games, totals, team_xg, goalie_xg, through = fetch_moneypuck(season, recent)
    except Exception as e:  # the site still works without xG
        print(f"  MoneyPuck unavailable: {e}")
        return
    def xg_fields(t):
        return {"xg": round(t["xg"], 2), "gMinusXg": round(t["mpG"] - t["xg"], 2)} if t else {"xg": None, "gMinusXg": None}
    for p in players:
        p.update(xg_fields(totals["season"].get(p["id"])))
    for w, win in recent.items():
        for pid, row in win["players"].items():
            row.update(xg_fields(totals[w].get(pid)))
    for ab, t in teams.items():
        t.update(team_xg.get(ab, {"xgfPct": None, "xgfPerGame": None, "xgaPerGame": None}))
    for g in goalies:
        g.update(goalie_xg.get(g["id"], {"xga": None, "gsax": None}))
    for w, win in recent.items():
        for pid, row in win.get("goalies", {}).items():
            t = totals["goalies"][w].get(pid)
            row["gsax"] = round(t["xga"] - t["ga"], 2) if t else None
    gamelogs["skaterCols"].append("xg")
    for pid, rows in gamelogs["skaters"].items():
        for r in rows:
            r.append(sk_games.get((pid, r[0])))
    gamelogs["goalieCols"].append("xga")
    for pid, rows in gamelogs["goalies"].items():
        for r in rows:
            r.append((gk_games.get((pid, r[0])) or (None,))[0])
    gamelogs["xgThrough"] = f"{through[:4]}-{through[4:6]}-{through[6:]}" if through else None
    print(f"  xG through {gamelogs['xgThrough']}")


def write(name, data):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote {name}.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=default_season(dt.date.today()))
    ap.add_argument("--days-ahead", type=int, default=7, help="days of ESPN probable goalies to fetch")
    ap.add_argument("--kind", default="manual", help="why this update ran (pre/post/manual), stored in meta.json")
    args = ap.parse_args()

    print(f"Season {args.season}")
    print("teams..."); teams = fetch_teams(args.season)
    abbrevs = sorted(teams)
    print("players..."); players, recent, goalies = fetch_players(args.season, dt.date.today())
    print("schedule..."); games = fetch_schedule(args.season, abbrevs)
    print("confirmed goalies..."); add_confirmed_goalies(games)
    print("probable goalies..."); add_probable_goalies(games, args.days_ahead)
    print("lines..."); lines = fetch_lines(games, abbrevs)
    print("goalie depth..."); depth = goalie_depth(games, goalies, abbrevs)
    for ab, d in depth.items():
        lines.setdefault(ab, {"forwards": [], "defense": [], "pp": [], "date": None, "opp": None})
        lines[ab].update(d)
    print("game logs..."); gamelogs = build_gamelogs(games)
    print("TSV..."); add_tsv(players, goalies)
    print("MoneyPuck xG..."); add_xg(args.season, players, recent, teams, goalies, gamelogs)

    labels = player_labels(lines)
    for p in players:
        p.update(labels.get(p["id"], {}))
    names = {p["id"]: p["name"] for p in players}
    for ln in lines.values():
        for kind in ("forwards", "defense", "pp"):
            for grp in ln[kind]:
                grp["names"] = [names.get(pid, str(pid)) for pid in grp["players"]]

    write("teams", teams)
    write("players", players)
    write("players_recent", recent)
    write("goalies", goalies)
    write("schedule", games)
    write("lines", lines)
    write("gamelogs", gamelogs)
    write("meta", {"season": args.season,
                   "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                   "priorGames": PRIOR_GAMES,
                   "xgThrough": gamelogs.get("xgThrough"),
                   "updateKind": args.kind})


if __name__ == "__main__":
    main()
