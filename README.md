# Trade Match

A mobile-friendly fantasy trade app for **Super Bowl Bound**. Choose your team, swipe through live-roster trade ideas, and get an in-app alert when both managers like the **exact same deal**. Discuss matches in your group chat and submit trades manually in Sleeper.

## Deploy on Netlify

**Import the GitHub repository into Netlify. Do not use a static drag-and-drop deploy:** the shared voting API needs Netlify Functions.

1. In Netlify, choose **Add new project → Import an existing project → GitHub**.
2. Select `antonioccollins/sleeper-fantasy`, branch **main**.
3. Netlify reads `netlify.toml`. If settings are requested, use:
   - Base directory: leave empty (repository root).
   - Build command: **`npm run build`**.
   - Publish directory: **`static`**.
   - Functions directory: **`netlify/functions`**.
4. Deploy. Node 22 and the locked npm dependencies are configured in the repository. No Python server, paid persistent disk, third-party database, Sleeper password, or API key is needed for this deployment.
5. Open the HTTPS URL Netlify assigns. The first visit loads the live league and generates its trade deck, which may take a few seconds.
6. Choose your own team. Have another manager open the **same URL** and choose theirs. Share that URL in the league group chat.

The app uses **site-wide Netlify Blobs** automatically authenticated by Netlify Functions. Votes, matches, and the session signing key persist across cold starts and redeploys of the **same Netlify site**. Different sites and local development have separate storage. Leave the default store name unchanged to retain votes. Your Netlify plan's normal Functions/Blobs usage limits and billing apply; this app does not provision another paid service.

No public Netlify deployment or website URL is created just by adding this configuration. Connect the repository and deploy in your Netlify account. No custom environment variables are required for Super Bowl Bound. To use another supported league, set `SLEEPER_LEAGUE_ID` in Netlify's environment settings and redeploy; this also selects separate league storage.

## Local preview

Install Node.js **22 or newer**, then:

```sh
npm ci
npm run dev
```

Open **http://localhost:8888** and choose your team. The official Netlify CLI runs the same static site, Functions, and a sandbox Blobs service. It needs no Netlify login with this offline local configuration; it still needs Internet access to fetch Sleeper data. Local data is stored under ignored `.netlify/` and never writes to the deployed site's votes.

The app uses Node Functions and no Edge Functions. In cloud development environments where the CLI cannot download its unrelated Deno/Edge runtime, local validation can use `npm run dev -- --internal-disable-edge-functions`; this CLI diagnostic option is unnecessary for the deployed website. Preserve platform proxy and TLS trust. On this cloud machine's Node 24 runtime, `NODE_USE_ENV_PROXY=1` enables its supplied proxy for live API requests.

## Data, votes, and matches

- The API reads real Sleeper league settings, teams, rosters, player metadata, and completed weekly scores.
- A scheduled Netlify Function refreshes production league data roughly every 15 minutes. Visits also refresh a missing/old snapshot, including in deploy previews where scheduled functions don't run. The large player directory is cached for 24 hours.
- Likes stay private until both managers like identical terms. They see the same proposal ID, with give/get reversed for their own team.
- Strongly consistent storage and ETag conditional updates prevent lost votes and duplicate matches across simultaneous Function instances. A league refresh lease limits duplicate API fetching.
- Undo and withdraw work before a match. Matched terms and per-manager alert acknowledgments persist. Historical matches retain their original players even when those players leave the roster.
- Roster/owner changes generate new proposal IDs so old likes cannot match stale trades. Votes pause when the source snapshot is more than an hour old.
- Notifications are **in-app**, about every 12 seconds while open and upon returning to the page. Unread alerts appear on a later visit. No email, push, or group-chat messages are sent.

As requested, team selection is **not identity-verified**: anyone with the URL can select any team and vote as it. Use this first version within your trusted league. Sessions are signed HTTP-only cookies; API operations are restricted to the selected team's trades and matches. Writes require same-origin JSON requests.

## Trade balance

Trade scores are a **transparent heuristic**, not expert market values. The engine uses this league's actual weekly scoring, averages non-zero scored weeks, and blends small samples with a position baseline from Sleeper's search rank. It adjusts for reported injuries, positional scarcity, starter fit, and bench depth.

It offers 1-for-1, 2-for-1, and 2-for-2 deals within an 18% value gap, excludes reserve players, limits low-value throw-ins, and accounts for a suggested drop when a package needs an extra roster spot. Cards focus on the players you give and get, with injury flags and any required roster drop. Background scoring and calculation details stay off the swipe screen; a brief explanation is available through the info button.

Zero-point games can be omitted along with byes/inactive weeks. Changing roles, news, keeper value, bye strategy, and future projections aren't fully modeled. No draft picks are suggested. Managers should review every deal; a mutual like is interest, not an executed trade.

## Validation

```sh
npm test
npm run build
npx netlify build --offline
```

Tests cover independent managers, mirrored terms, exact matches, private likes, concurrent writes and cold instances, undo, historical terms, stale-roster guards, signed sessions, per-team alerts, and the official Blobs emulator's conditional writes. The production build bundles all three Functions and their routes/schedule.

Optional browser testing requires Python's Playwright package and Chromium. Start the local Netlify runtime with an isolated test store:

```sh
TRADE_MATCH_STORE=trade-match-browser-test npm run dev
```

In another terminal:

```sh
SMOKE_BASE_URL=http://localhost:8888 python3 scripts/browser_smoke.py
```

The browser test selects two actual league teams in the local sandbox, verifies a private like and mutual swipe match on desktop/mobile, and saves screenshots in ignored `test-results/`. Use a fresh test store name for each run. It refuses public deployment URLs. `TRADE_MATCH_STORE` is for local test isolation; don't set or change it in production.

## Optional Python development server

The original Python/SQLite implementation remains available for local development and self-hosting. It is **not used by Netlify**:

```sh
python3 sync.py
python3 app.py
```

Open port 8000. Python 3.12+ is required, and the standard-library development server has no extra dependencies. Its votes are in `.data/tradematch.sqlite3`, separate from Netlify Blobs. For the Docker/self-hosted production variant, dependencies are pinned in `requirements-python.txt`. Run its separate regression suite with `AUTO_SYNC=0 python3 -m unittest discover -s tests -v`.
