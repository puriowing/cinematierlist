import urllib.error, json, os, threading, unittest, urllib.request, tempfile
os.environ.setdefault("TIARI_SITE", "music")
os.environ.setdefault("TIARI_DATA_DIR", tempfile.mkdtemp())
import server
from http.server import ThreadingHTTPServer

class SiteRoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def get(self, p):
        return urllib.request.urlopen(f"http://127.0.0.1:{self.port}{p}").read().decode()

    def test_site_js(self):
        self.assertIn("tiari for Music", self.get("/site.js"))

    def test_manifest(self):
        self.assertEqual(json.loads(self.get("/manifest.webmanifest"))["name"], "tiari for Music")

    def test_data_dir(self):
        self.assertEqual(server.DATA_DIR, os.environ["TIARI_DATA_DIR"])

    def test_itunes_search(self):
        import itunes
        self.addCleanup(setattr, itunes, "fetch_json", itunes.fetch_json)
        itunes.fetch_json = lambda url: {"results": [{"wrapperType": "track", "kind": "song", "trackId": 1, "trackName": "X"}]}
        r = json.loads(self.get("/api/itunes/search?q=X&type=song"))
        self.assertEqual(r["results"][0]["itunesId"], "1")

    def post_itunes(self, p, body):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{p}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        return json.loads(urllib.request.urlopen(req).read().decode())

    def test_itunes_uses_device_fetched_results(self):
        server.itunes._en_titles.clear()
        calls = []
        self.addCleanup(setattr, server, "_fetch", server._fetch)
        server._fetch = lambda u, use_cache=True: calls.append(u) or json.dumps({"results": []})
        track = {"wrapperType": "track", "kind": "song", "trackId": 7, "trackName": "Y", "artistId": 3,
                 "artistName": "A", "collectionId": 9, "collectionName": "Al"}
        # app.js の appleItunesUrl と同じ組み立て（URLSearchParams の並び順）
        url = "https://itunes.apple.com/search?country=JP&lang=ja_jp&term=Y+Z&media=music&entity=song&limit=50"
        # app.js の usLookupUrls と同じ組み立て（米国ストアの曲名）
        us = "https://itunes.apple.com/lookup?id=7&country=US"
        us_data = {"results": [dict(track, trackName="Y (2009 Remaster)")]}
        r = self.post_itunes("/api/itunes/search?type=all&q=" + urllib.parse.quote("Y Z"),
                             {"raw": {url: {"results": [track]}, us: us_data}})
        self.assertEqual((r["songs"][0]["itunesId"], r["songs"][0]["keyTitle"]), ("7", "Y"))
        self.assertEqual(calls, [])
        self.assertEqual(server.itunes._en_titles.get("7"), None)  # 端末の結果は共有メモリに残さない
        url = "https://itunes.apple.com/lookup?country=JP&lang=ja_jp&id=3&entity=song&limit=200"
        r = self.post_itunes("/api/itunes/artist?id=3", {"raw": {url: {"results": [track]}, us: us_data}})
        self.assertEqual((r["songs"][0]["itunesId"], calls), ("7", []))
        r = self.post_itunes("/api/itunes/artist?id=3", {"raw": {url: {"results": [track]}}})
        self.assertEqual(calls, [us])  # 米国ストアの分が無ければサーバーが取得する

    def test_itunes_ignores_foreign_raw(self):
        calls = []
        self.addCleanup(setattr, server, "_fetch", server._fetch)
        server._fetch = lambda u, use_cache=True: calls.append(u) or json.dumps({"results": []})
        self.post_itunes("/api/itunes/album?id=5", {"raw": {"https://evil.example/lookup?country=JP&lang=ja_jp&id=5&entity=song": {"results": []}}})
        self.assertEqual(len(calls), 1)

    def test_register_has_no_recovery_code(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/auth/register",
                                     data=json.dumps({"username": "rc_test_user", "password": "secret123"}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        r = json.loads(urllib.request.urlopen(req).read().decode())
        self.assertNotIn("recoveryCode", r)
        self.assertFalse(r["user"]["hasRecovery"])

    def test_itunes_empty_id(self):
        for k in ("artist", "album"):
            with self.assertRaises(urllib.error.HTTPError) as c:
                self.get(f"/api/itunes/{k}?id=")
            self.assertEqual(c.exception.code, 400)

    def test_itunes_404_without_feature(self):
        self.addCleanup(server.SITE.__setitem__, "features", server.SITE["features"])
        server.SITE["features"] = [f for f in server.SITE["features"] if f != "itunes"]
        with self.assertRaises(urllib.error.HTTPError) as c:
            self.get("/api/itunes/search?q=X")
        self.assertEqual(c.exception.code, 404)
