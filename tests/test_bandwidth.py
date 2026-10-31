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
        self.assertIn("max-age=31536000", h["Cache-Control"])

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


if __name__ == "__main__":
    unittest.main()
