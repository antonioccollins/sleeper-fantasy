# TradeBlock

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
4. Deploy. Node 22 and the locked npm dependencies are configured in the repository. No Python server, paid persistent disk, third-party database, or Sleeper password is needed. In **Project configuration → Environment variables**, add **`FANTASYPROS_API_KEY`**, mark it as a secret, and enable the **Functions** scope for production (and deploy previews if used). Enter the key there, then deploy/redeploy. Never prefix it with a browser-exposed variable name.
5. Open the HTTPS URL Netlify assigns. The first visit loads the live league and generates its trade deck, which may take a few seconds.
6. Choose your own team. Have another manager open the **same URL** and choose theirs. Share that URL in the league group chat.

The app uses **site-wide Netlify Blobs** automatically authenticated by Netlify Functions. Votes, matches, and the session signing key persist across cold starts and redeploys of the **same Netlify site**. Different sites and local development have separate storage. Leave the default store name unchanged to retain votes. Your Netlify plan's normal Functions/Blobs usage limits and billing apply; this app does not provision another paid service.

No public Netlify deployment or website URL is created just by adding this configuration. Connect the repository and deploy in your Netlify account. The FantasyPros key is required for recommendations. Without usable rankings the website still loads teams and saved matches, but pauses the trade deck; it never falls back to the retired Sleeper valuation engine. To use another supported league, set `SLEEPER_LEAGUE_ID` in Netlify's environment settings and redeploy; this also selects separate league storage.

## Local preview

Install Node.js **22 or newer**, then:

```sh
npm ci
npm run dev
```

Open **http://localhost:8888** and choose your team. The official Netlify CLI runs the same static site, Functions, and a sandbox Blobs service. It needs no Netlify login with this offline local configuration; it still needs Internet access to Sleeper and FantasyPros. Supply `FANTASYPROS_API_KEY` through your environment or an ignored `.env` file; `.env.example` lists the name without a value. Local data is stored under ignored `.netlify/` and never writes to the deployed site's votes.

The app uses Node Functions and no Edge Functions. In cloud development environments where the CLI cannot download its unrelated Deno/Edge runtime, local validation can use `npm run dev -- --internal-disable-edge-functions`; this CLI diagnostic option is unnecessary for the deployed website. Preserve platform proxy and TLS trust. On this cloud machine's Node 24 runtime, `NODE_USE_ENV_PROXY=1` enables its supplied proxy for live API requests.

## Data, votes, and matches

- The API reads real Sleeper league settings, teams, rosters, and player metadata. [FantasyPros](https://api.fantasypros.com/public/v2/docs) provides NFL rest-of-season expert consensus rankings for the Sleeper league season and standard, half-PPR, or PPR format.
- A scheduled Netlify Function refreshes production league data roughly every 15 minutes. Visits also refresh a missing/old snapshot, including in deploy previews where scheduled functions don't run. The large player directory is cached for 24 hours.
- Likes stay private until both managers like identical terms. They see the same proposal ID, with give/get reversed for their own team. Eligible offers already liked by the other manager lead the deck; ordinary suggestions still rotate across teams. Returning to the app and minute-by-minute activity checks refresh that order while keeping the current card in place. Existing passes, trade-type filters, and completed matches are respected.
- Strongly consistent storage and ETag conditional updates prevent lost votes and duplicate matches across simultaneous Function instances. A league refresh lease limits duplicate API fetching.
- Undo and withdraw work before a match. Matched terms and per-manager alert acknowledgments persist. Historical matches retain their original players even when those players leave the roster.
- Roster/owner changes generate new proposal IDs so old likes cannot match stale trades. Votes pause when the source snapshot is more than an hour old.
- Notifications are **in-app**, about every 12 seconds while open and upon returning to the page. Unread alerts appear on a later visit. No email, push, or group-chat messages are sent.

As requested, team selection is **not identity-verified**: anyone with the URL can select any team and vote as it. Use this first version within your trusted league. Sessions are signed HTTP-only cookies; API operations are restricted to the selected team's trades and matches. Writes require same-origin JSON requests.

## Trade balance

FantasyPros **rest-of-season expert consensus rankings** are the primary valuation input, replacing Sleeper search order and recent-game averages. The API request is `GET /public/v2/json/nfl/{league season}/consensus-rankings?type=ROS&scoring=HALF&position=ALL` for Super Bowl Bound. Credentials are sent only in the server-side `x-api-key` header. Rankings must match NFL, the league season, ROS, scoring, and position, and have a publication timestamp no older than seven days. A FantasyPros account/key must permit this endpoint; the app reports safe availability reasons through `/health` without exposing credentials or upstream bodies.

If the API returns a truncated sample list, the server checks the full ranking JSON published on FantasyPros' public ROS page for the same scoring format. It sends no API key to that page, executes no scripts, and applies the same season/type/scoring/freshness and coverage checks. `/health` identifies this source as `via: public_page`. A blocked, changed, paywalled, or incomplete page is rejected; it never fills missing players with guessed values.

Player identities use Yahoo IDs where available, otherwise a unique normalized name plus position. Ambiguous or unmapped players cannot be traded or suggested as drops. At least 70% of rostered offensive players, covering all rostered offensive positions, must match. Rankings are cached privately in Netlify Blobs for six hours, limiting requests to about four refreshes a day per season/scoring format (occasionally a supplementary QB request). An outage can reuse a valid cache for up to 36 hours from its original fetch, without resetting that timestamp. Unavailable, incompatible, insufficiently mapped, or expired rankings pause suggestions and voting. Failures have a 15-minute retry cooldown.

**Our trade values are estimates derived from those rankings, not FantasyPros trade-chart prices or point projections.** An exponential value curve protects elite assets, and two-player packages carry a 12% consolidation premium. Accepted deals have at most a 12% adjusted value gap after accounting for roster drops. Similar-value same-position swaps are included, allowing managers to act on their player preferences even when the lineup model favors one side. Trades changing positional composition must improve both teams under a positional-rank lineup/backup model, without weakening either best starting lineup. Each incoming piece in a 2-for-1 must contribute to the recipient's lineup. Weak throw-ins, reserve players, and repetitive proposals are filtered out.

Rankings already incorporate expert expectations about future performance and injuries; we do not additionally halve an injured player's long-term value based on a current Out flag. Injury labels remain visible for managers to review. Cards stay focused on the give/get players; methodology is behind the info button. This version supports ordinary one-QB redraft/keeper leagues with standard/half/PPR scoring. Superflex, two-QB, TE-premium, dynasty values, draft picks, custom scoring adjustments, and individual manager preferences aren't modeled. Mutual interest is not an executed trade.

The original migration from the retired Sleeper valuation model invalidates its pending votes while retaining saved match terms. Adding same-position swaps preserves existing roster epochs and proposal IDs. Routine ranking refreshes keep proposal IDs stable for identical terms and rosters; a deal must still pass current checks to receive a new vote. Roster, owner, or reserve changes invalidate pending terms.

## Risk Taker Index

The separate **Risk Taker** tab uses completed Sleeper transactions for the connected league’s season (weeks 0–18, including offseason activity). It never reads TradeBlock likes, matches, or FantasyPros rankings. `/api/risk` is a read-only endpoint for public league activity, cached separately in Netlify Blobs for 15 minutes and refreshed on demand.

The score is rounded to 0–100: **40 points** for trades relative to the league’s highest trade count, **35 points** for successful FAAB bids as a fraction of the starting budget (capped at 100%), and **25 points** for roster moves relative to the league’s highest move count. Non-FAAB leagues use 60 trade points and 40 move points. Equal scores share ranks. It measures activity and spending, not trade quality or predicted wins.

Each completed trade counts once per participating roster, including picks and FAAB transfers. Waiver/free-agent transactions count as one move even when they include both an add and a drop. FAAB spending sums successful waiver bids; failed bids and transferred budget do not count. Duplicate transaction IDs are deduplicated using their latest status. Incomplete history fails the refresh; an existing snapshot remains visibly marked as delayed with its original timestamp, or the tab shows an unavailable state with a retry button.

## Personal player rankings

The **Rankings** tab saves each manager’s ordered lists of up to 25 players at QB, RB, WR, TE, K, and DEF. Search includes unrostered NFL players. Drag the six-dot handle or hold and drag a player to reorder (with edge auto-scrolling), or tap a rank number. Quick touch swipes still scroll the list. Remove/add players and explicitly save each position. The optional starting list uses available roster positional rankings followed by Sleeper search order; it is only an editable draft and never counts as a manager’s opinion until saved.

Opportunities compare the saved lists of two current owners. Both players must appear in both managers’ lists at the same position, and each manager must rank the player they would receive above their own. Unlisted players are not assumed to rank below listed players. Opportunities use current roster ownership, including reserve players, and pause when the roster snapshot is over an hour old. They do not require FantasyPros availability or the trade generator’s value filter, and they never create likes or confirmed matches.

Both managers get an in-app badge/banner and opportunity cards with mirrored terms and the two relevant rank comparisons. Alerts refresh while the app is open and on return; viewing the Opportunities panel marks only that manager’s alerts as read. There are no external messages or push notifications. Rankings and read state are stored separately from votes in season-scoped Netlify Blobs. Owner changes invalidate the previous owner’s preferences. Atomic saves preserve different teams/positions, and revision checks reject outdated edits from another session. Full ranking lists are returned only for the selected team, using the same open team-selection model as the rest of the app.

## Validation

```sh
npm test
npm run build
npx netlify build --offline
```

Tests cover provider request/authentication, ranking metadata and age, caching and cooldowns, identity matching, missing credentials, elite-player protection and mutual lineup benefit, as well as independent managers, mirrored terms, exact matches, private likes, concurrent writes and cold instances, undo, historical terms, stale-roster guards, signed sessions, per-team alerts, and the official Blobs emulator's conditional writes. The production build bundles all three Functions and their routes/schedule.

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

The original Python/SQLite implementation remains available for local development and self-hosting. It is **not used by Netlify** and retains the original heuristic engine; it does not use FantasyPros. Use `npm run dev` to preview current recommendations:

```sh
python3 sync.py
python3 app.py
```

Open port 8000. Python 3.12+ is required, and the standard-library development server has no extra dependencies. Its votes are in `.data/tradematch.sqlite3`, separate from Netlify Blobs. For the Docker/self-hosted production variant, dependencies are pinned in `requirements-python.txt`. Run its separate regression suite with `AUTO_SYNC=0 python3 -m unittest discover -s tests -v`.
