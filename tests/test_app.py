from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

os.environ["AUTO_SYNC"] = "0"
from app import Application
from engine import generate


def fixture():
    players = {
        pid: {"id":pid,"name":name,"position":"RB" if pid.endswith("1") else "WR",
              "nfl_team":"BUF","injury":None,"value":20.0,"estimate":10.0,"average":10.0,"sample_weeks":5}
        for pid,name in [("a1","First Runner"),("a2","First Receiver"),("b1","Second Runner"),("b2","Second Receiver"),("c1","Third Runner"),("c2","Third Receiver")]
    }
    def proposal(pid, give_b):
        return {"id":pid,"a":1,"b":2,"give_a":["a1"],"give_b":[give_b],"value_a":20,"value_b":20,
                "gap":0,"kind":"1-for-1","score":8,"drops":{"1":[],"2":[]},"starter_gain":{"1":1,"2":1},"fit_gain":{"1":1,"2":1}}
    return {
        "league":{"league_id":"test","name":"Test League","season":"2026","total_rosters":3},
        "teams":[{"id":i,"name":f"Team {i}","manager":f"Manager {i}","owner_id":str(i),"players":[f'{letter}1',f'{letter}2'],"reserve":[],"wins":3,"losses":2,"ties":0} for i,letter in enumerate("abc",1)],
        "players":players,"proposals":[proposal("trade-one","b1"),proposal("trade-two","b2")],
        "updated_at":datetime.now(timezone.utc).isoformat(),"epoch":"test-epoch","completed_weeks":5,"scoring":"Half PPR",
    }


class Client:
    def __init__(self, app):
        self.app, self.cookie = app, ""

    def request(self, path, method="GET", body=None, origin=None):
        raw = json.dumps(body or {}).encode()
        path, _, query = path.partition("?")
        env={"PATH_INFO":path,"QUERY_STRING":query,"REQUEST_METHOD":method,"HTTP_HOST":"test.local",
             "CONTENT_TYPE":"application/json","CONTENT_LENGTH":str(len(raw)),"wsgi.input":io.BytesIO(raw),
             "wsgi.url_scheme":"https","HTTP_COOKIE":self.cookie}
        if origin:
            env["HTTP_ORIGIN"]=origin
        response={}
        def start(status, headers):
            response["status"] = int(status.split()[0])
            response["headers"] = dict(headers)
            if "Set-Cookie" in response["headers"]:
                self.cookie = response["headers"]["Set-Cookie"].split(";")[0]
        data=b"".join(self.app(env,start))
        return response["status"], json.loads(data)

    def choose(self, team):
        assert self.request("/api/session","POST",{"team_id":team})[0] == 200

    def vote(self, pid, decision="like"):
        return self.request("/api/votes","POST",{"proposal_id":pid,"decision":decision})


class MatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.model = fixture()
        self.write_model()
        self.app = Application(self.root)
        self.a,self.b,self.c = (Client(self.app) for _ in range(3))
        for client,team in [(self.a,1),(self.b,2),(self.c,3)]:
            client.choose(team)

    def tearDown(self):
        self.temp.cleanup()

    def write_model(self):
        (self.root/"model.json").write_text(json.dumps(self.model))

    def test_mirrored_terms_and_exact_mutual_match(self):
        a=self.a.request('/api/deck')[1]['proposals'][0]
        b=self.b.request('/api/deck')[1]['proposals'][0]
        self.assertEqual(a['id'],b['id'])
        self.assertEqual(a['give'],b['receive'])
        self.assertEqual(a['receive'],b['give'])
        self.assertFalse(self.a.vote('trade-one')[1]['matched'])
        self.assertEqual(self.b.request('/api/likes')[1]['items'],[])
        self.assertEqual(self.b.request('/api/matches')[1]['items'],[])
        self.assertFalse(self.b.vote('trade-two')[1]['matched'])
        result=self.b.vote('trade-one')[1]
        self.assertTrue(result['matched'])
        self.assertEqual(result['match']['give'][0]['id'],'b1')
        for client in (self.a,self.b):
            matches=client.request('/api/matches')[1]['items']
            self.assertEqual(len(matches),1)
            self.assertTrue(matches[0]['unread'])
        self.assertEqual(self.c.request('/api/matches')[1]['items'],[])

    def test_concurrent_votes_make_one_durable_match(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda c:c.vote('trade-one'),(self.a,self.b)))
        self.assertEqual([r[0] for r in results],[200,200])
        self.assertEqual(sum(r[1]['matched'] for r in results),1)
        restarted=Application(self.root)
        self.a.app=restarted
        self.assertEqual(len(self.a.request('/api/matches')[1]['items']),1)
        self.assertEqual(self.a.request('/api/votes/trade-one','DELETE')[0],409)
        with restarted.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM matches').fetchone()[0],1)

    def test_undo_pass_and_withdraw_like(self):
        self.a.vote('trade-one','pass')
        self.assertNotIn('trade-one',[p['id'] for p in self.a.request('/api/deck')[1]['proposals']])
        self.assertEqual(self.a.request('/api/votes/trade-one','DELETE')[0],200)
        self.assertIn('trade-one',[p['id'] for p in self.a.request('/api/deck')[1]['proposals']])
        self.a.vote('trade-one')
        self.assertEqual(len(self.a.request('/api/likes')[1]['items']),1)
        self.a.request('/api/votes/trade-one','DELETE')
        self.assertFalse(self.b.vote('trade-one')[1]['matched'])

    def test_roster_refresh_expires_votes_and_preserves_match_terms(self):
        self.a.vote('trade-one');self.b.vote('trade-one')
        self.model['proposals']=[]
        self.model['players'].pop('a1')
        self.model['teams'][0]['players'].remove('a1')
        self.write_model()
        self.assertEqual(self.a.vote('trade-one')[0],409)
        match=self.a.request('/api/matches')[1]['items'][0]
        self.assertFalse(match['available'])
        self.assertEqual(match['give'][0]['name'],'First Runner')

    def test_team_bound_sessions_and_same_origin_writes(self):
        guest=Client(self.app)
        self.assertEqual(guest.vote('trade-one')[0],401)
        self.assertEqual(self.c.vote('trade-one')[0],409)
        self.assertEqual(self.c.request('/api/votes/trade-one','DELETE')[0],404)
        self.assertEqual(self.a.request('/api/votes','POST',{'proposal_id':'trade-one','decision':'like'},origin='https://evil.local')[0],403)
        guest.cookie=self.a.cookie+'tamper'
        self.assertEqual(guest.request('/api/deck')[0],401)
        self.assertEqual(self.a.vote('trade-one','bogus')[0],400)

    def test_stale_data_pauses_voting_but_keeps_read_access(self):
        self.model['updated_at']=(datetime.now(timezone.utc)-timedelta(hours=2)).isoformat()
        self.write_model()
        self.assertTrue(self.a.request('/api/deck')[1]['stale'])
        self.assertEqual(self.a.vote('trade-one')[0],503)

    def test_read_alert_is_per_team(self):
        self.a.vote('trade-one');self.b.vote('trade-one')
        self.assertEqual(self.a.request('/api/matches/trade-one','POST')[0],200)
        self.assertFalse(self.a.request('/api/matches')[1]['items'][0]['unread'])
        self.assertTrue(self.b.request('/api/matches')[1]['items'][0]['unread'])
        self.assertEqual(self.c.request('/api/matches/trade-one','POST')[0],404)


class EngineTests(unittest.TestCase):
    def test_generated_trades_are_owned_balanced_unique_and_reproducible(self):
        players={}
        rosters=[]
        for team in range(1,4):
            ids=[]
            for i,pos in enumerate(['QB','RB','RB','WR','WR','TE','WR','RB']):
                pid=f'{team}-{i}'
                ids.append(pid)
                players[pid]={'player_id':pid,'full_name':pid,'position':pos,'team':'BUF','search_rank':i*3+team,'injury_status':None}
            rosters.append({'roster_id':team,'owner_id':str(team),'players':ids,'reserve':[ids[-1]],'settings':{}})
        weeks=[[{'players_points':{pid:10+(int(pid[0])+int(pid[-1]))%5 for pid in players}}] for _ in range(5)]
        league={'league_id':'fixture','season':'2026','name':'Fixture','total_rosters':3,'roster_positions':['QB','RB','RB','WR','WR','TE','FLEX','BN'],'scoring_settings':{'rec':.5}}
        users=[{'user_id':str(i),'display_name':str(i)} for i in range(1,4)]
        m=generate(league,rosters,users,players,weeks)
        self.assertGreater(len(m['proposals']),0)
        self.assertEqual(m['proposals'],generate(league,rosters,users,players,weeks)['proposals'])
        self.assertEqual(len({p['id'] for p in m['proposals']}),len(m['proposals']))
        teams={t['roster_id']:t for t in rosters}
        for p in m['proposals']:
            self.assertLessEqual(abs(p['value_a']-p['value_b'])/max(p['value_a'],p['value_b']),.185)
            for team_id,key in [(p['a'],'give_a'),(p['b'],'give_b')]:
                self.assertTrue(set(p[key])<=set(teams[team_id]['players']))
                self.assertFalse(set(p[key])&set(teams[team_id]['reserve']))
        rosters[0]['players'].remove(rosters[0]['players'][0])
        changed=generate(league,rosters,users,players,weeks)
        self.assertNotEqual(m['epoch'],changed['epoch'])
        self.assertFalse({p['id'] for p in m['proposals']}&{p['id'] for p in changed['proposals']})


if __name__ == '__main__':
    unittest.main()
