# Trade Match

A mobile-friendly trade discovery app for **super bowl bound**, built with real Sleeper rosters and scoring. Managers choose their team, swipe through suggested deals, and receive an in-app alert when both sides like the **same exact trade**. Trades are discussed and executed manually in Sleeper.

## What works

- Live Sleeper league, team, roster, player, and completed-week scoring data.
- Swipe gestures, keyboard arrows, accessible pass/like buttons, and trade-type filters.
- 1-for-1, 2-for-1, and 2-for-2 proposals shared by both managers, oriented from each manager's perspective.
- Private likes, undo/withdraw, durable shared votes, mutual-match alerts, pending likes, and match history.
- SQLite transactions enforce mutual agreement on identical terms. Votes and session signing keys survive process restarts.
- Roster data refreshes roughly every 15 minutes; the large player directory is cached for 24 hours. Roster or owner changes create a new proposal generation so old likes cannot match stale terms. Historical matches remain visible as unavailable. Voting pauses when data is over an hour old.

## Run locally

Python 3.12 or newer. The development server and tests use only the standard library.

```sh
cd /workspace/sleeper-fantasy
python3 sync.py
python3 app.py
```

`PORT` defaults to `8000`. The server serves the site and API together. `GET /health` verifies that a league snapshot is loaded. Requests to the public Sleeper API need HTTPS access to `api.sleeper.app`. No Sleeper password or API key is required. In Codex, use the execution tool's network escalation when its sandbox blocks network or listening sockets; preserve proxy and TLS settings.

For production:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
python3 sync.py
.venv/bin/gunicorn --bind 0.0.0.0:8000 --workers 1 --threads 8 app:application
```

Keep **one worker and one service instance** with SQLite. A shared, persistent filesystem is required. `.data/` is ignored by Git and contains cached Sleeper data, the session signing key, and the vote database. Back up `tradematch.sqlite3` using SQLite's backup API; don't copy a live database without its WAL state.

## Share a real website link

`render.yaml` prepares a Render web service with a persistent disk. **A paid web service and disk are required**; check Render's current pricing before creating it. The free service's temporary filesystem would lose votes and matches, so it is not used here.

1. Publish this source to the selected GitHub repository, preserving any existing work.
2. Sign in to Render, create a **Blueprint**, and select the repository and branch containing `render.yaml`.
3. Review the service and storage costs, then deploy. Render installs dependencies, syncs Sleeper, and starts the server with durable data under `/var/data`.
4. Wait for the health check to pass. Open the **public HTTPS URL Render assigns**, select your team, and test with a second manager/browser.
5. Send that public URL to your league's group chat. Both managers must use the **same deployed service** for votes to match.

No public deployment or Render URL has been created merely by adding this configuration. The development environment does not supply a public host. Redeploys preserve the disk, but publishing this cloud development environment alone does not publish this website.

An alternative is the Dockerfile on your own server. Mount a persistent volume at `/var/data`, serve HTTPS through your reverse proxy, and use one instance.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `SLEEPER_LEAGUE_ID` | `1314338659381575680` | Super Bowl Bound |
| `DATA_DIR` | `.data/` next to `app.py` | Persistent snapshots and SQLite database |
| `PORT` | `8000` for development | Listening port |
| `AUTO_SYNC` | `1` | Background roster refresh; set `0` in tests |

## What “balanced” means

This is a **transparent scoring heuristic**, not a professional trade-value feed. The engine:

1. Uses actual weekly scores from this league, so half-PPR and custom scoring are included.
2. Averages non-zero scored weeks and blends small samples toward a position-specific baseline using Sleeper search rank. Zero scores may indicate inactivity or byes; this approximation also omits genuine zero-point games.
3. Discounts reported injuries and assigns a scarcity adjustment by position.
4. Generates packages whose summed trade scores differ by at most 18%, excludes reserve players, and avoids a low-value throw-in plus another player being offered for a star.
5. Compares starter fit and bench depth on both sides. Any package that adds a roster spot includes a suggested drop and accounts for that drop in its roster-fit calculation.

Cards show the players, scores, injury flags, value gap, roster fit, and any needed drop. Estimates can miss bye-week strategy, changing roles, news, rest-of-season projections, market sentiment, and keeper value. No draft picks are suggested. Review the actual trade; a mutual like is interest, not an executed transaction.

## Identity and notifications

As requested, managers **choose their team without account verification**. Anyone with the URL can select any team and vote as it. This is appropriate for a trusted league prototype; add verified identity or team access codes before wider use. Sessions are signed, HTTP-only cookies; once selected, APIs enforce team ownership of votes and match visibility. Writes are same-origin JSON requests.

Match alerts are **in the app**: polling about every 12 seconds while open, plus immediate checks when returning to the page. Alerts persist and appear on the next visit. No group-chat, email, or push messages are sent.

## Tests

```sh
AUTO_SYNC=0 python3 -m unittest discover -s tests -v
```

The suite exercises independent manager sessions, mirrored trade terms, private likes, exact mutual agreement, concurrent voting, durable matches after restart, undo, stale roster invalidation, and authorization. Browser smoke testing uses Playwright against a separate test database, with no votes written to the development league database. With Playwright and Chromium installed, run `python3 scripts/browser_smoke.py`; it requires a synced `.data/model.json` and the production virtual environment and saves screenshots in ignored `test-results/`.
