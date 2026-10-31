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

    def test_itunes_empty_id(self):
        for k in ("artist", "album"):
            with self.assertRaises(urllib.error.HTTPError) as c:
                self.get(f"/api/itunes/{k}?id=")
            self.assertEqual(c.exception.code, 400)
