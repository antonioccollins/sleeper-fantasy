"""Transparent, roster-aware trade suggestions for a redraft league."""
from collections import defaultdict
from itertools import combinations
import hashlib
import json

POSITIONS = {"QB", "RB", "WR", "TE"}
ELIGIBILITY = {
    "QB": {"QB"}, "RB": {"RB"}, "WR": {"WR"}, "TE": {"TE"},
    "FLEX": {"RB", "WR", "TE"}, "SUPER_FLEX": POSITIONS,
    "WRRB_FLEX": {"WR", "RB"}, "REC_FLEX": {"WR", "TE"},
}


def player_ratings(players, rosters, weeks):
    samples = defaultdict(dict)
    for week, matchups in enumerate(weeks):
        for matchup in matchups:
            for pid, points in (matchup.get("players_points") or {}).items():
                # Zero scores include byes and inactive weeks; don't call them played games.
                if points != 0:
                    samples[pid][week] = float(points)
    ranks = {}
    for position in POSITIONS:
        ranked = sorted(
            (p for p in players.values() if p.get("position") == position and p.get("team")),
            key=lambda p: p.get("search_rank") or 99999,
        )
        ranks.update({p["player_id"]: i + 1 for i, p in enumerate(ranked)})
    result = {}
    for pid in {pid for roster in rosters for pid in (roster.get("players") or [])}:
        p = players.get(pid, {})
        position = p.get("position", "DEF" if pid.isalpha() else "?")
        rank = ranks.get(pid, 100)
        prior = {
            "QB": max(8, 24 - .5 * (rank - 1)),
            "RB": 18 / (1 + .030 * (rank - 1)),
            "WR": 18 / (1 + .023 * (rank - 1)),
            "TE": 15 / (1 + .060 * (rank - 1)),
        }.get(position, 0)
        history = list(samples[pid].values())
        # Shrink small samples toward a position-specific baseline from Sleeper search rank.
        weight = len(history) / (len(history) + 6)
        average = sum(history) / len(history) if history else prior
        estimated = weight * average + (1 - weight) * prior
        injury = p.get("injury_status")
        adjustment = {"Questionable": .95, "Doubtful": .70, "Out": .65, "IR": .45}.get(injury, 1)
        estimated *= adjustment
        replacement = {"QB": 14, "RB": 7, "WR": 7, "TE": 5}.get(position, 0)
        value = max(2, estimated * 1.6 + max(0, estimated - replacement) * 3)
        result[pid] = {
            "id": pid, "name": p.get("full_name") or pid,
            "position": position, "nfl_team": p.get("team") or "FA",
            "injury": injury, "value": round(value, 1),
            "estimate": round(estimated, 1), "average": round(average, 1),
            "sample_weeks": len(history),
        }
    return result


def lineup_strength(ids, ratings, slots):
    remaining = set(ids)
    starters = 0.0
    relevant = [s for s in slots if s in ELIGIBILITY]
    # This league has single-position slots followed by ordinary FLEX.
    for slot in sorted(relevant, key=lambda s: len(ELIGIBILITY[s])):
        eligible = [pid for pid in remaining if ratings[pid]["position"] in ELIGIBILITY[slot]]
        if eligible:
            best = max(eligible, key=lambda pid: ratings[pid]["estimate"])
            starters += ratings[best]["estimate"]
            remaining.remove(best)
    bench = sum(ratings[pid]["estimate"] for pid in remaining if ratings[pid]["position"] in POSITIONS)
    return starters, starters + .08 * bench


def generate(league, rosters, users, players, weeks):
    ratings = player_ratings(players, rosters, weeks)
    user_map = {u["user_id"]: u for u in users}
    teams = []
    for roster in rosters:
        owner = user_map.get(roster.get("owner_id"), {})
        stats = roster.get("settings") or {}
        metadata = owner.get("metadata") or {}
        teams.append({
            "id": roster["roster_id"], "owner_id": roster.get("owner_id"),
            "name": metadata.get("team_name") or owner.get("display_name") or f"Team {roster['roster_id']}",
            "manager": owner.get("display_name") or "Unclaimed",
            "wins": stats.get("wins", 0), "losses": stats.get("losses", 0), "ties": stats.get("ties", 0),
            "players": sorted(roster.get("players") or []),
            "reserve": roster.get("reserve") or [],
        })
    epoch = hashlib.sha256(json.dumps(
        [(t["id"], t["owner_id"], t["players"]) for t in sorted(teams, key=lambda t: t["id"])],
        sort_keys=True,
    ).encode()).hexdigest()[:16]
    slots = league["roster_positions"]
    proposals = []
    for a, b in combinations(sorted(teams, key=lambda t: t["id"]), 2):
        if not a["owner_id"] or not b["owner_id"]:
            continue
        tradable = lambda team: sorted(
            (pid for pid in team["players"] if ratings[pid]["position"] in POSITIONS and pid not in team["reserve"] and ratings[pid]["value"] >= 10),
            key=lambda pid: ratings[pid]["value"], reverse=True,
        )[:12]
        pool_a, pool_b = tradable(a), tradable(b)
        bundles_a = {1: [(p,) for p in pool_a], 2: list(combinations(pool_a, 2))}
        bundles_b = {1: [(p,) for p in pool_b], 2: list(combinations(pool_b, 2))}
        before_a = lineup_strength(set(a["players"])-set(a["reserve"]), ratings, slots)
        before_b = lineup_strength(set(b["players"])-set(b["reserve"]), ratings, slots)
        for count_a, count_b in ((1, 1), (2, 1), (1, 2), (2, 2)):
            candidates = []
            for give_a in bundles_a[count_a]:
                value_a = sum(ratings[p]["value"] for p in give_a)
                for give_b in bundles_b[count_b]:
                    value_b = sum(ratings[p]["value"] for p in give_b)
                    gap = abs(value_a - value_b) / max(value_a, value_b)
                    if gap > .18:
                        continue
                    # Avoid two low-value pieces being presented as an upgrade for a star.
                    if count_a != count_b:
                        package, single = (give_a, give_b) if count_a == 2 else (give_b, give_a)
                        if min(ratings[p]["value"] for p in package) < ratings[single[0]]["value"] * .28:
                            continue
                    candidates.append((gap, give_a, give_b, value_a, value_b))
            # Evaluate all balanced candidates; keep six diverse options per shape and team pair.
            accepted = []
            for gap, give_a, give_b, value_a, value_b in candidates:
                after_ids_a = (set(a["players"]) - set(give_a)) | set(give_b)
                after_ids_b = (set(b["players"]) - set(give_b)) | set(give_a)
                drops = {str(a["id"]): [], str(b["id"]): []}
                for team, ids, received in ((a, after_ids_a, give_b), (b, after_ids_b, give_a)):
                    extra = max(0, len(ids) - len(team["players"]))
                    drop_pool = sorted(
                        (p for p in ids if p not in received and p not in team["reserve"] and ratings[p]["position"] in POSITIONS),
                        key=lambda pid: ratings[pid]["value"],
                    )
                    if len(drop_pool) < extra:
                        break
                    for pid in drop_pool[:extra]:
                        ids.remove(pid)
                        drops[str(team["id"])].append(pid)
                else:
                    after_a = lineup_strength(after_ids_a-set(a["reserve"]), ratings, slots)
                    after_b = lineup_strength(after_ids_b-set(b["reserve"]), ratings, slots)
                    gain_a, gain_b = after_a[1] - before_a[1], after_b[1] - before_b[1]
                    if min(gain_a, gain_b) < -1.5:
                        continue
                    score = (1 - gap) * 6 + min(gain_a, gain_b) * 2 + gain_a + gain_b
                    key = [league["league_id"], league["season"], epoch, a["id"], b["id"], sorted(give_a), sorted(give_b)]
                    pid = hashlib.sha256(json.dumps(key).encode()).hexdigest()[:24]
                    accepted.append({
                        "id": pid, "a": a["id"], "b": b["id"],
                        "give_a": sorted(give_a), "give_b": sorted(give_b),
                        "value_a": round(value_a, 1), "value_b": round(value_b, 1),
                        "gap": round(gap * 100), "kind": f"{min(count_a,count_b)}-for-{max(count_a,count_b)}",
                        "score": round(score, 2), "drops": drops,
                        "starter_gain": {str(a["id"]): round(after_a[0]-before_a[0], 1), str(b["id"]): round(after_b[0]-before_b[0], 1)},
                        "fit_gain": {str(a["id"]): round(gain_a, 1), str(b["id"]): round(gain_b, 1)},
                    })
            used = defaultdict(int)
            selected = 0
            for proposal in sorted(accepted, key=lambda p: p["score"], reverse=True):
                # A single player shouldn't dominate the deck.
                if any(used[p] >= 3 for p in proposal["give_a"] + proposal["give_b"]):
                    continue
                proposals.append(proposal)
                for p in proposal["give_a"] + proposal["give_b"]:
                    used[p] += 1
                selected += 1
                if selected == 6:
                    break
    return {
        "league": {k: league[k] for k in ["league_id", "name", "season", "total_rosters"]},
        "scoring": "Half PPR" if league.get("scoring_settings", {}).get("rec") == .5 else f"{league.get('scoring_settings', {}).get('rec',0)} PPR",
        "teams": teams, "players": ratings, "proposals": proposals,
        "epoch": epoch, "completed_weeks": len(weeks),
    }
