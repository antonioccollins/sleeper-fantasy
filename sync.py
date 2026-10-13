"""Refresh league data; cache the large player directory for at least 24 hours."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
import urllib.request
from engine import generate

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).parent / ".data"))
LEAGUE_ID = os.environ.get("SLEEPER_LEAGUE_ID", "1314338659381575680")


def get(path):
    request = urllib.request.Request(
        "https://api.sleeper.app/v1/" + path,
        headers={"Accept": "application/json", "User-Agent": "TradeMatch/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def atomic_json(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value))
    temp.replace(path)


def refresh():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    league = get(f"league/{LEAGUE_ID}")
    if not isinstance(league, dict) or not league.get("league_id"):
        raise ValueError("Sleeper league was not found")
    if league.get("sport") != "nfl" or league.get("settings", {}).get("type") not in (0, 1):
        raise ValueError("This trade engine supports NFL redraft/keeper leagues")
    final_week = min(int(league.get("settings", {}).get("last_scored_leg", 0)), 18)
    requests = {"rosters": f"league/{LEAGUE_ID}/rosters", "users": f"league/{LEAGUE_ID}/users"}
    requests.update({f"week_{week}": f"league/{LEAGUE_ID}/matchups/{week}" for week in range(1, final_week+1)})
    player_path = DATA_DIR / "players.json"
    if not player_path.exists() or time.time() - player_path.stat().st_mtime > 86400:
        requests["players"] = "players/nfl"
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {key: pool.submit(get, path) for key, path in requests.items()}
        data = {key: future.result() for key, future in futures.items()}
    if "players" in data:
        atomic_json(player_path, data["players"])
    players = data.get("players") or json.loads(player_path.read_text())
    model = generate(league, data["rosters"], data["users"], players, [data[f"week_{week}"] for week in range(1, final_week+1)])
    model["updated_at"] = datetime.now(timezone.utc).isoformat()
    atomic_json(DATA_DIR / "model.json", model)
    return model


if __name__ == "__main__":
    model = refresh()
    print(f"Synced {model['league']['name']}: {len(model['teams'])} teams, {len(model['proposals'])} balanced trade ideas.")
