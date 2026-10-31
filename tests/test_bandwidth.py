import gzip, io, json, os, tempfile, threading, unittest, urllib.error, urllib.parse, urllib.request
os.environ.setdefault("TIARI_SITE", "music")
os.environ.setdefault("TIARI_DATA_DIR", tempfile.mkdtemp())
import server
from http.server import ThreadingHTTPServer


class BandwidthTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def req(self, path, headers=None):
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers=headers or {})
        try:
            with urllib.request.urlopen(r) as res:
                return res.status, res.headers, res.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def test_poster_url_direct(self):
        self.assertEqual(server._poster_url("//d2ueuvlup6lbue.cloudfront.net/a.jpg"),
                         "https://d2ueuvlup6lbue.cloudfront.net/a.jpg")
        self.assertEqual(server._poster_url("https://x/noimg.png"), "")
        self.assertEqual(server._poster_url(""), "")

    def test_static_etag_304(self):
        st, h, body = self.req("/app.js?v=1")
        self.assertEqual(st, 200)
        self.assertEqual(h["Cache-Control"], "no-cache")
        with open(os.path.join(server.APP_DIR, "app.js"), "rb") as f:
            self.assertEqual(body, f.read())
        st, h2, body = self.req("/app.js?v=1", {"If-None-Match": h["ETag"]})
        self.assertEqual(st, 304)
        self.assertEqual(body, b"")
        st, _, _ = self.req("/app.js", {"If-None-Match": '"other"'})
        self.assertEqual(st, 200)

    def test_static_gzip(self):
        st, h, body = self.req("/app.js", {"Accept-Encoding": "gzip, br"})
        self.assertEqual(st, 200)
        self.assertEqual(h["Content-Encoding"], "gzip")
        self.assertIn("Accept-Encoding", h["Vary"])
        with open(os.path.join(server.APP_DIR, "app.js"), "rb") as f:
            self.assertEqual(gzip.decompress(body), f.read())
        self.assertEqual(int(h["Content-Length"]), len(body))
        st, _, _ = self.req("/app.js", {"Accept-Encoding": "gzip", "If-None-Match": h["ETag"]})
        self.assertEqual(st, 304)

    def test_index_and_404(self):
        st, h, _ = self.req("/")
        self.assertEqual(st, 200)
        self.assertTrue(h["Content-Type"].startswith("text/html"))
        self.assertEqual(self.req("/server.py")[0], 404)
        self.assertEqual(self.req("/data/x.json")[0], 404)

    def test_versioned_icon_long_cache(self):
        st, h, _ = self.req("/icons/apple-touch-icon.png?v=4")
        self.assertEqual(st, 200)
        self.assertEqual(h["Cache-Control"], "public, max-age=2592000")

    def test_generated_site_js_etag(self):
        st, h, _ = self.req("/site.js")
        self.assertEqual(st, 200)
        self.assertEqual(self.req("/site.js", {"If-None-Match": h["ETag"]})[0], 304)

    def test_json_gzip(self):
        big = {"results": ["x" * 50] * 100}
        orig = server.Handler._h_demo
        self.addCleanup(setattr, server.Handler, "_h_demo", orig)
        server.Handler._h_demo = lambda self: self._send_json(big)
        st, h, body = self.req("/api/demo", {"Accept-Encoding": "gzip"})
        self.assertEqual(h["Content-Encoding"], "gzip")
        self.assertEqual(json.loads(gzip.decompress(body)), big)
        st, h, body = self.req("/api/demo")
        self.assertIsNone(h["Content-Encoding"])
        self.assertEqual(json.loads(body), big)

    def test_public_api_cache_header(self):
        orig = server.filmarks_search
        self.addCleanup(setattr, server, "filmarks_search", orig)
        server.filmarks_search = lambda q: [{"id": "1", "title": q}]
        st, h, _ = self.req("/api/filmarks/search?q=x")
        self.assertEqual(st, 200)
        self.assertEqual(h["Cache-Control"], "public, max-age=3600")
        st, h, _ = self.req("/api/filmarks/search?q=")
        self.assertEqual(st, 400)
        self.assertIsNone(h["Cache-Control"])

    def test_list_since_same(self):
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/auth/register", method="POST",
                                   data=json.dumps({"username": "bwsince", "password": os.urandom(8).hex()}).encode(),
                                   headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(r) as res:
            cookie = res.headers["Set-Cookie"].split(";", 1)[0]
        body = json.dumps({"tiers": [], "updatedAt": 123}).encode()
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/list", method="POST", data=body,
                                   headers={"Content-Type": "application/json", "Cookie": cookie})
        urllib.request.urlopen(r).read()
        _, _, b = self.req("/api/list?since=123", {"Cookie": cookie})
        self.assertEqual(json.loads(b), {"same": True})
        _, _, b = self.req("/api/list?since=100", {"Cookie": cookie})
        self.assertEqual(json.loads(b)["list"]["updatedAt"], 123)

    def test_api_img_proxy(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(setattr, server, "CACHE_DIR", server.CACHE_DIR)
        server.CACHE_DIR = tmp

        class Res(io.BytesIO):
            headers = {"Content-Type": "image/jpeg"}
            def __enter__(self): return self
            def __exit__(self, *a): pass

        orig = urllib.request.urlopen
        calls = []
        def fake(req, timeout=None):
            if isinstance(req, urllib.request.Request) and req.full_url.startswith("https://d2ueuvlup6lbue.cloudfront.net/"):
                calls.append(req.full_url)
                return Res(b"JPEGDATA")
            return orig(req, timeout=timeout) if timeout else orig(req)
        urllib.request.urlopen = fake
        self.addCleanup(setattr, urllib.request, "urlopen", orig)
        u = "https://d2ueuvlup6lbue.cloudfront.net/p.jpg"
        st, h, body = self.req("/api/img?u=" + urllib.parse.quote(u, safe=""))
        self.assertEqual(st, 200)
        self.assertEqual(body, b"JPEGDATA")
        self.assertEqual(h["Access-Control-Allow-Origin"], "*")
        self.assertEqual(calls, [u])
        self.assertEqual(self.req("/api/img?u=ftp%3A%2F%2Fx")[0], 400)


class ServerFetchTest(unittest.TestCase):
    def test_fetch_requests_and_decodes_gzip(self):
        seen = {}

        class Res(io.BytesIO):
            headers = {"Content-Encoding": "gzip"}
            def __enter__(self): return self
            def __exit__(self, *a): pass

        def fake(req, timeout=None):
            seen["ae"] = req.get_header("Accept-encoding")
            return Res(gzip.compress("<html>映画</html>".encode()))
        orig = urllib.request.urlopen
        urllib.request.urlopen = fake
        self.addCleanup(setattr, urllib.request, "urlopen", orig)
        self.assertEqual(server._fetch("https://filmarks.com/x", use_cache=False), "<html>映画</html>")
        self.assertEqual(seen["ae"], "gzip")

    def test_remote_restore_downloads_each_file_once(self):
        calls = []
        listings = {"": [{"type": "file", "name": "users.json", "sha": "u1"}, {"type": "dir", "name": "lists"},
                         {"type": "file", "name": "README.md", "sha": "r"}],
                    "lists": [{"type": "file", "name": "a.json", "sha": "a1"}], "challenges": []}
        def fake_gh(method, rel, body=None, raw=False):
            calls.append((rel, raw))
            return b"{}" if raw else listings.get(rel)
        orig = server._gh
        server._gh = fake_gh
        self.addCleanup(setattr, server, "_gh", orig)
        server._remote_restore()
        self.assertEqual(sorted(r for r, raw in calls if raw), ["lists/a.json", "users.json"])
        self.assertEqual(len([1 for _, raw in calls if not raw]), 3)
        self.assertEqual(server._remote_sha["lists/a.json"], "a1")

    def _patch_upload(self):
        sent = []
        orig = server._remote_upload
        server._remote_upload = lambda rel: sent.append(rel)
        self.addCleanup(setattr, server, "_remote_upload", orig)
        self.addCleanup(server._gh_timeout.__setitem__, 0, server._gh_timeout[0])
        self.addCleanup(server._remote_seq.clear)
        self.addCleanup(server._remote_sent_seq.clear)
        return sent

    def test_flush_on_shutdown_includes_inflight_in_order(self):
        sent = self._patch_upload()
        server._remote_pending.update({"lists/b.json", "users.json", "challenges/c.json"})
        server._remote_inflight.add("lists/a.json")
        server._remote_flush(shutdown=True)
        self.assertEqual(sent, ["users.json", "challenges/c.json", "lists/a.json", "lists/b.json"])
        self.assertEqual(server._remote_inflight, set())
        self.assertEqual(server._remote_pending, set())
        self.assertEqual(server._gh_timeout[0], 8)

    def test_flush_skips_inflight_already_sent(self):
        sent = self._patch_upload()
        orig_q = server.REMOTE_ON
        server.REMOTE_ON = True
        self.addCleanup(setattr, server, "REMOTE_ON", orig_q)
        server._remote_queue(os.path.join(server.DATA_DIR, "lists", "a.json"))
        server._remote_flush()
        self.assertEqual(sent, ["lists/a.json"])
        server._remote_inflight.add("lists/a.json")
        server._remote_flush(shutdown=True)
        self.assertEqual(sent, ["lists/a.json"])
        server._remote_queue(os.path.join(server.DATA_DIR, "lists", "a.json"))
        server._remote_inflight.add("lists/a.json")
        server._remote_pending.discard("lists/a.json")
        server._remote_flush(shutdown=True)
        self.assertEqual(sent, ["lists/a.json", "lists/a.json"])

    def test_api_ttl(self):
        self.assertEqual(server._api_ttl("/api/filmarks/search"), 3600)
        self.assertEqual(server._api_ttl("/api/filmarks/details"), 7 * 24 * 3600)
        self.assertEqual(server._api_ttl("/api/filmarks/release_year"), 24 * 3600)
        self.assertEqual(server._api_ttl("/api/watch"), 3 * 3600)
        self.assertEqual(server._api_ttl("/api/list"), 0)
        self.assertEqual(server._api_ttl("/api/community/top"), 0)

    def test_save_list_skips_remote_when_only_updated_changes(self):
        queued = []
        orig = server._remote_queue
        server._remote_queue = lambda path: queued.append(path)
        self.addCleanup(setattr, server, "_remote_queue", orig)
        uid = "bwtest-skip"
        server._save_list(uid, {"tiers": [{"id": "s", "items": [1]}], "updatedAt": 1})
        server._save_list(uid, {"tiers": [{"id": "s", "items": [1]}], "updatedAt": 2})
        self.assertEqual(len(queued), 1)
        server._save_list(uid, {"tiers": [{"id": "s", "items": [1, 2]}], "updatedAt": 3})
        self.assertEqual(len(queued), 2)
        self.assertEqual(server._load_list(uid)["updatedAt"], 3)


if __name__ == "__main__":
    unittest.main()
