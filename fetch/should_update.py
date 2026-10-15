"""Decide whether the scheduled workflow should refresh the site right now.

GitHub Actions wakes this up every 30 minutes. It looks at the NHL slates (game days)
for yesterday and today and asks for an update when:

  pre-game:  it is within PRE_GAME before a slate's first puck drop, and the live site
             hasn't been updated since that window opened.
  post-game: every game of a slate is final, at least LAST_GAME_LENGTH + POST_GAME has
             passed since its last puck drop, and the site hasn't been updated since then.

"Already updated" is read from the deployed site's data/meta.json, so no state is kept here.

Usage:  python fetch/should_update.py [--now 2026-10-15T23:10:00Z] [--meta-url URL] [--force]
Prints run=true|false and kind=pre|post|manual, and also writes them to $GITHUB_OUTPUT.
"""

import argparse
import datetime as dt
import json
import os
import urllib.request

WEB = "https://api-web.nhle.com/v1"
PRE_GAME = dt.timedelta(hours=1)
LAST_GAME_LENGTH = dt.timedelta(hours=2, minutes=45)  # the feed has no end time; a game rarely runs longer
POST_GAME = dt.timedelta(hours=1)
FINAL_STATES = ("OFF", "FINAL")


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (nhl-stats-prototype)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_utc(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def last_update(meta_url):
    """When the live site was last generated, or None if it can't be read (e.g. first deploy)."""
    if not meta_url:
        return None
    try:
        return parse_utc(get_json(meta_url)["generated"])
    except Exception as e:
        print(f"could not read {meta_url}: {e}")
        return None


def decide(now, slates, updated):
    """Return (kind, reason) for the first update that is due, or (None, reason)."""
    for day, games in slates:
        starts = [parse_utc(g["startTimeUTC"]) for g in games]
        first, last = min(starts), max(starts)
        pre_due = first - PRE_GAME
        if pre_due <= now < first and (updated is None or updated < pre_due):
            return "pre", f"{day}: first game {first:%H:%M} UTC"
        post_due = last + LAST_GAME_LENGTH + POST_GAME
        all_final = all(g.get("gameState") in FINAL_STATES for g in games)
        if all_final and now >= post_due and (updated is None or updated < post_due):
            return "post", f"{day}: last game started {last:%H:%M} UTC, all final"
    return None, "nothing due"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--now", help="pretend it's this UTC time (for testing)")
    ap.add_argument("--meta-url", default=os.environ.get("SITE_META_URL"))
    ap.add_argument("--force", action="store_true", default=os.environ.get("FORCE") == "true")
    args = ap.parse_args()

    now = parse_utc(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
    if args.force:
        kind, reason = "manual", "forced"
    else:
        # The week starting yesterday holds both yesterday's and today's slates (dates are NHL game days)
        week = get_json(f"{WEB}/schedule/{(now - dt.timedelta(days=1)).date()}")["gameWeek"]
        slates = [(d["date"], [g for g in d["games"] if g.get("gameType") in (2, 3)]) for d in week[:2]]
        slates = [(d, gs) for d, gs in slates if gs]
        kind, reason = decide(now, slates, last_update(args.meta_url))

    run = kind is not None
    print(f"run={str(run).lower()} kind={kind or ''} ({reason})")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"run={str(run).lower()}\nkind={kind or ''}\n")


if __name__ == "__main__":
    main()
