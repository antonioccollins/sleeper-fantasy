"""Trade Match: WSGI app with shared, durable SQLite votes and matches."""
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.cookies import CookieError
import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from urllib.parse import parse_qs, urlsplit
from wsgiref.simple_server import make_server, WSGIServer
from socketserver import ThreadingMixIn

from sync import DATA_DIR, refresh

ROOT = Path(__file__).parent
LOG = logging.getLogger("tradematch")


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Application:
    def __init__(self, data_dir=DATA_DIR):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / "tradematch.sqlite3"
        self.lock = threading.RLock()
        self.model, self.model_mtime = None, None
        with self.db() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS proposals (
                    id TEXT PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL,
                    payload TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
                CREATE TABLE IF NOT EXISTS votes (
                    proposal_id TEXT NOT NULL REFERENCES proposals(id), team INTEGER NOT NULL,
                    decision TEXT NOT NULL CHECK(decision IN ('like','pass')), updated_at TEXT NOT NULL,
                    PRIMARY KEY(proposal_id,team));
                CREATE TABLE IF NOT EXISTS matches (
                    proposal_id TEXT PRIMARY KEY REFERENCES proposals(id), created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS seen (
                    proposal_id TEXT NOT NULL REFERENCES matches(proposal_id), team INTEGER NOT NULL,
                    PRIMARY KEY(proposal_id,team));
            """)
            db.execute("INSERT OR IGNORE INTO settings VALUES ('session_secret', ?)", (secrets.token_hex(32),))
            self.secret = db.execute("SELECT value FROM settings WHERE key='session_secret'").fetchone()[0].encode()

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def load_model(self):
        with self.lock:
            path = self.data_dir / "model.json"
            if not path.exists():
                raise APIError(503, "League data is not ready yet. Please try again shortly.")
            mtime = path.stat().st_mtime_ns
            if mtime != self.model_mtime:
                model = json.loads(path.read_text())
                with self.db() as db:
                    db.execute("UPDATE proposals SET active=0 WHERE active=1")
                    db.executemany(
                        "INSERT INTO proposals(id,a,b,payload,active) VALUES (?,?,?,?,1) "
                        "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,active=1",
                        [(p["id"],p["a"],p["b"],json.dumps({**p,
                            "_players":{pid:model["players"][pid] for pid in set(p["give_a"]+p["give_b"]+sum(p["drops"].values(),[]))},
                            "_teams":model["teams"],
                        })) for p in model["proposals"]],
                    )
                self.model, self.model_mtime = model, mtime
            return self.model

    def session_token(self, team):
        payload = base64.urlsafe_b64encode(json.dumps({"team": team,"expires":int(time.time())+86400*30}).encode()).decode().rstrip("=")
        return payload + "." + hmac.new(self.secret, payload.encode(), hashlib.sha256).hexdigest()

    def current_team(self, env, model, required=True):
        try:
            cookie = SimpleCookie(env.get("HTTP_COOKIE", ""))
            token = cookie["trade_session"].value
            payload, signature = token.split(".")
            expected = hmac.new(self.secret, payload.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                raise ValueError()
            decoded = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload)%4)))
            if decoded["expires"] < time.time():
                raise ValueError()
            team = next(t for t in model["teams"] if t["id"] == decoded["team"] and t["owner_id"])
            return team
        except (KeyError, ValueError, StopIteration, TypeError, CookieError, binascii.Error):
            if required:
                raise APIError(401, "Choose your team to continue.")
            return None

    @staticmethod
    def freshness(model):
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(model["updated_at"])).total_seconds()
        return age > 3600

    def decorate(self, proposal, team, model):
        is_a = proposal["a"] == team["id"]
        partner_id = proposal["b"] if is_a else proposal["a"]
        partner = next((t for t in model["teams"] if t["id"] == partner_id), None)
        if partner is None:
            partner = next(t for t in proposal.get("_teams", []) if t["id"] == partner_id)
        players = {**proposal.get("_players", {}), **model["players"]}
        give, receive = (proposal["give_a"], proposal["give_b"]) if is_a else (proposal["give_b"],proposal["give_a"])
        return {
            "id":proposal["id"],"partner": {k:partner[k] for k in ["id","name","manager"]},
            "give":[players[p] for p in give],"receive":[players[p] for p in receive],
            "give_value":proposal["value_a"] if is_a else proposal["value_b"],
            "receive_value":proposal["value_b"] if is_a else proposal["value_a"],
            "gap":proposal["gap"],"kind":proposal["kind"],
            "starter_gain":proposal["starter_gain"][str(team["id"])],
            "partner_starter_gain":proposal["starter_gain"][str(partner_id)],
            "drops":[players[p] for p in proposal["drops"][str(team["id"])]],
            "partner_drops":[players[p] for p in proposal["drops"][str(partner_id)]],
        }

    def body(self, env):
        if env.get("CONTENT_TYPE", "").split(";")[0] != "application/json":
            raise APIError(415, "Use a JSON request.")
        try:
            length = int(env.get("CONTENT_LENGTH") or 0)
            if length > 4096 or length < 0:
                raise APIError(413, "Request is too large.")
            data = json.loads(env["wsgi.input"].read(length))
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (ValueError, UnicodeDecodeError):
            raise APIError(400, "Invalid request.")

    def route(self, env):
        path, method = env["PATH_INFO"], env["REQUEST_METHOD"]
        if method not in ("GET", "POST", "DELETE"):
            raise APIError(405, "Method not allowed.")
        if method != "GET":
            origin = env.get("HTTP_ORIGIN")
            if origin and urlsplit(origin).netloc.lower() != env.get("HTTP_HOST", "").lower():
                raise APIError(403, "Requests must come from this website.")
        if path == "/health" and method == "GET":
            model = self.load_model()
            return {"status":"ok","league":model["league"]["name"],"updated_at":model["updated_at"],"stale":self.freshness(model)}, []
        model = self.load_model()
        team = self.current_team(env, model, required=False)
        if path == "/api/bootstrap" and method == "GET":
            return {"league":model["league"], "scoring":model["scoring"],"teams":model["teams"],
                    "players":model["players"],"team":team,"updated_at":model["updated_at"],
                    "stale":self.freshness(model),"completed_weeks":model["completed_weeks"],"epoch":model["epoch"]}, []
        if path == "/api/session" and method == "POST":
            team_id = self.body(env).get("team_id")
            selected = next((t for t in model["teams"] if t["id"] == team_id and t["owner_id"]), None)
            if selected is None:
                raise APIError(400, "Choose a team in this league.")
            secure = "; Secure" if env.get("HTTP_X_FORWARDED_PROTO",env.get("wsgi.url_scheme")) == "https" else ""
            cookie = f"trade_session={self.session_token(team_id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000{secure}"
            return {"team":selected}, [("Set-Cookie",cookie)]
        if path == "/api/session" and method == "DELETE":
            return {"ok":True}, [("Set-Cookie","trade_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")]
        if team is None:
            raise APIError(401, "Choose your team to continue.")
        if path == "/api/deck" and method == "GET":
            query = parse_qs(env.get("QUERY_STRING", ""))
            kind = query.get("kind", ["all"])[0]
            with self.db() as db:
                voted = {r[0] for r in db.execute("SELECT proposal_id FROM votes WHERE team=?",(team["id"],))}
            proposals = [p for p in model["proposals"] if team["id"] in (p["a"],p["b"]) and p["id"] not in voted and (kind=="all" or p["kind"]==kind)]
            buckets = defaultdict(deque)
            for p in sorted(proposals,key=lambda p:p["score"],reverse=True):
                buckets[p["b"] if p["a"]==team["id"] else p["a"]].append(p)
            ordered = []
            while any(buckets.values()):
                for partner in sorted(buckets):
                    if buckets[partner]:
                        ordered.append(buckets[partner].popleft())
            return {"proposals":[self.decorate(p,team,model) for p in ordered],"stale":self.freshness(model)}, []
        if path == "/api/votes" and method == "POST":
            if self.freshness(model):
                raise APIError(503, "Roster updates are delayed. Voting is paused until Sleeper reconnects.")
            body = self.body(env)
            if body.get("decision") not in ("like","pass"):
                raise APIError(400, "Choose like or pass.")
            with self.db() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT * FROM proposals WHERE id=? AND active=1",(body.get("proposal_id"),)).fetchone()
                if row is None or team["id"] not in (row["a"],row["b"]):
                    raise APIError(409, "This trade is no longer available. Refresh your deck.")
                if db.execute("SELECT 1 FROM matches WHERE proposal_id=?",(row["id"],)).fetchone():
                    raise APIError(409, "This trade is already a match. Find it in your matches.")
                now = datetime.now(timezone.utc).isoformat()
                db.execute("INSERT INTO votes VALUES (?,?,?,?) ON CONFLICT(proposal_id,team) DO UPDATE SET decision=excluded.decision,updated_at=excluded.updated_at",
                           (row["id"],team["id"],body["decision"],now))
                yes = db.execute("SELECT COUNT(*) FROM votes WHERE proposal_id=? AND decision='like' AND team IN (?,?)",(row["id"],row["a"],row["b"])).fetchone()[0]
                matched = yes == 2
                if matched:
                    db.execute("INSERT OR IGNORE INTO matches VALUES (?,?)",(row["id"],now))
            result = {"ok":True,"matched":matched}
            if matched:
                result["match"] = {**self.decorate(json.loads(row["payload"]),team,model),"created_at":now,"unread":True,"available":True}
            return result, []
        if path.startswith("/api/votes/") and method == "DELETE":
            proposal_id = path.removeprefix("/api/votes/")
            with self.db() as db:
                db.execute("BEGIN IMMEDIATE")
                proposal = db.execute("SELECT a,b FROM proposals WHERE id=?",(proposal_id,)).fetchone()
                if proposal is None or team["id"] not in tuple(proposal):
                    raise APIError(404, "Trade not found.")
                if db.execute("SELECT 1 FROM matches WHERE proposal_id=?",(proposal_id,)).fetchone():
                    raise APIError(409, "Both managers liked this trade, so it is already a match.")
                db.execute("DELETE FROM votes WHERE proposal_id=? AND team=?",(proposal_id,team["id"]))
            return {"ok":True}, []
        if path in ("/api/matches", "/api/likes") and method == "GET":
            with self.db() as db:
                if path == "/api/matches":
                    rows = db.execute("SELECT p.*,m.created_at,s.team AS seen FROM matches m JOIN proposals p ON p.id=m.proposal_id LEFT JOIN seen s ON s.proposal_id=p.id AND s.team=? WHERE p.a=? OR p.b=? ORDER BY m.created_at DESC",(team["id"],team["id"],team["id"])).fetchall()
                else:
                    rows = db.execute("SELECT p.*,v.updated_at AS created_at FROM votes v JOIN proposals p ON p.id=v.proposal_id LEFT JOIN matches m ON m.proposal_id=p.id WHERE v.team=? AND v.decision='like' AND m.proposal_id IS NULL AND p.active=1 ORDER BY v.updated_at DESC",(team["id"],)).fetchall()
            items = []
            for row in rows:
                p = json.loads(row["payload"])
                try:
                    item = self.decorate(p,team,model)
                except KeyError:
                    # A historical match may contain a player who has since left the league.
                    item = {"id":row["id"],"partner":{"name":"Former trade partner"},"give":[],"receive":[],"kind":p["kind"]}
                items.append({**item,"created_at":row["created_at"],"available":bool(row["active"]),
                              "unread":path=="/api/matches" and row["seen"] is None})
            return {"items":items}, []
        if path.startswith("/api/matches/") and method == "POST":
            proposal_id = path.removeprefix("/api/matches/")
            self.body(env)
            with self.db() as db:
                row = db.execute("SELECT p.a,p.b FROM matches m JOIN proposals p ON p.id=m.proposal_id WHERE p.id=?",(proposal_id,)).fetchone()
                if not row or team["id"] not in tuple(row):
                    raise APIError(404, "Match not found.")
                db.execute("INSERT OR IGNORE INTO seen VALUES (?,?)",(proposal_id,team["id"]))
            return {"ok":True}, []
        raise APIError(404, "Not found.")

    def __call__(self, env, start_response):
        path = env.get("PATH_INFO", "/")
        static = {"/":("index.html","text/html"),"/app.js":("app.js","text/javascript"),"/styles.css":("styles.css","text/css"),"/favicon.svg":("favicon.svg","image/svg+xml")}
        security = [("X-Content-Type-Options","nosniff"),("Referrer-Policy","same-origin"),
                    ("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://sleepercdn.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")]
        if path in static and env["REQUEST_METHOD"] == "GET":
            filename, mime = static[path]
            data = (ROOT/"static"/filename).read_bytes()
            start_response("200 OK",[("Content-Type",mime+"; charset=utf-8"),("Content-Length",str(len(data))),("Cache-Control","no-cache")]+security)
            return [data]
        try:
            result, extra = self.route(env)
            status = "200 OK"
        except APIError as error:
            result, extra = {"error":error.message}, []
            status = f"{error.status} Error"
        except Exception:
            LOG.exception("Request failed")
            result, extra, status = {"error":"Something went wrong. Please try again."}, [], "500 Error"
        data = json.dumps(result).encode()
        start_response(status,[("Content-Type","application/json"),("Content-Length",str(len(data))),("Cache-Control","no-store")]+extra+security)
        return [data]


application = Application()


def background_sync():
    while True:
        time.sleep(60)
        path = DATA_DIR/"model.json"
        if not path.exists() or time.time()-path.stat().st_mtime > 900:
            try:
                refresh()
                LOG.info("League data refreshed")
            except Exception:
                LOG.exception("Sleeper refresh failed; keeping the last valid roster snapshot")
                time.sleep(240)


if os.environ.get("AUTO_SYNC", "1") != "0":
    threading.Thread(target=background_sync,daemon=True).start()


if __name__ == "__main__":
    class Server(ThreadingMixIn, WSGIServer):
        daemon_threads = True
    port = int(os.environ.get("PORT", "8000"))
    logging.basicConfig(level=logging.INFO)
    print(f"Trade Match listening on port {port}",flush=True)
    make_server("0.0.0.0",port,application,server_class=Server).serve_forever()
