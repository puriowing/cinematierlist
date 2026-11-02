import json, os, tempfile, threading, unittest, urllib.error, urllib.parse, urllib.request
os.environ.setdefault("TIARI_SITE", "music")
os.environ.setdefault("TIARI_DATA_DIR", tempfile.mkdtemp())
import server
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GROUPS = {"年代", "シーン", "ジャンル", "種別"}


def load():
    with open(os.path.join(ROOT, "music_themes.json"), encoding="utf-8") as f:
        return json.load(f)["themes"]


class MusicThemesJsonTest(unittest.TestCase):
    def test_shape(self):
        themes = load()
        self.assertGreaterEqual(len(themes), 20)
        self.assertEqual(len({t["id"] for t in themes}), len(themes))
        for t in themes:
            self.assertIn(t["group"], GROUPS)
            self.assertTrue(t["label"] and t["description"])
            self.assertGreaterEqual(len(t["songs"]), 10, t["label"])

    def test_songs(self):
        for t in load():
            keys = set()
            for s in t["songs"]:
                for k in ("itunesId", "title", "artist", "poster"):
                    self.assertTrue(s.get(k), (t["id"], k, s))
                self.assertTrue(s["itunesId"].isdigit())
                u = urllib.parse.urlsplit(s["poster"])
                self.assertEqual(u.scheme, "https")
                self.assertTrue(u.hostname.endswith(".mzstatic.com"), s["poster"])
                if s.get("previewUrl"):
                    self.assertTrue(server._music_url_ok("previewUrl", s["previewUrl"]), s["previewUrl"])
                if s.get("appleUrl"):
                    self.assertTrue(server._music_url_ok("appleUrl", s["appleUrl"]), s["appleUrl"])
                k = server._movie_key(s)
                self.assertTrue(k.startswith("s:"))
                self.assertNotIn(k, keys, (t["id"], s["title"]))
                keys.add(k)

    def test_notes_only_on_scenes(self):
        for t in load():
            for s in t["songs"]:
                if "note" in s:
                    self.assertIn(t["id"], ("drama", "anime", "movie"))
                    self.assertIn("『", s["note"])


class MusicThemesRouteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def open(self, p):
        return urllib.request.urlopen(f"http://127.0.0.1:{self.port}{p}")

    def test_list(self):
        r = self.open("/api/music/themes")
        self.assertIn("max-age=86400", r.headers.get("Cache-Control", ""))
        themes = json.loads(r.read())["themes"]
        self.assertEqual(len(themes), len(load()))
        self.assertEqual(set(themes[0]), {"id", "group", "label", "description", "count"})
        self.assertNotIn("songs", themes[0])

    def test_detail(self):
        t = json.loads(self.open("/api/music/themes/y90").read())
        self.assertEqual(t["label"], "90年代ヒット")
        self.assertTrue(t["songs"][0]["itunesId"])

    def test_unknown(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.open("/api/music/themes/nope")
        self.assertEqual(cm.exception.code, 404)

    def test_music_only(self):
        site = dict(server.SITE, features=[f for f in server.SITE.get("features", []) if f != "itunes"])
        self.addCleanup(setattr, server, "SITE", server.SITE)
        server.SITE = site
        for p in ("/api/music/themes", "/api/music/themes/y90"):
            with self.assertRaises(urllib.error.HTTPError) as cm:
                self.open(p)
            self.assertEqual(cm.exception.code, 404)

    def test_cinema_loads_no_themes(self):
        self.addCleanup(setattr, server, "SITE", server.SITE)
        server.SITE = dict(server.SITE, features=[])
        self.assertEqual(server._load_music_themes(), {})


if __name__ == "__main__":
    unittest.main()
