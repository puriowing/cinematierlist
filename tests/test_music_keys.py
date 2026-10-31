import os, tempfile, unittest
os.environ.setdefault("TIARI_SITE", "music")
os.environ.setdefault("TIARI_DATA_DIR", tempfile.mkdtemp())
import server


class MusicKeyTest(unittest.TestCase):
    def test_itunes_key(self):
        self.assertEqual(server._movie_key({"itunesId": "123", "title": "x"}), "i:123")
        self.assertEqual(server._movie_key({"itunesId": "123", "title": "Ｈｅｌｌｏ！ World", "artist": "Mr.Children"}),
                         "s:mrchildren|helloworld")

    def test_same_song_other_album_same_key(self):
        a = server._movie_key({"itunesId": "1", "title": "曲A", "artist": "歌手"})
        self.assertEqual(a, server._movie_key({"itunesId": "2", "title": "曲Ａ", "artist": "歌手 "}))
        self.assertNotEqual(a, server._movie_key({"itunesId": "3", "title": "曲A (Live)", "artist": "歌手"}))

    def test_challenge_keeps_music_fields(self):
        out = server._clean_challenge_movies([{"title": "曲", "itunesId": "9", "artist": "A",
                                               "poster": "https://is1-ssl.mzstatic.com/a.jpg", "previewUrl": "https://audio-ssl.itunes.apple.com/a.m4a"}])
        self.assertEqual(out[0]["key"], "s:a|曲")
        self.assertEqual(out[0]["previewUrl"], "https://audio-ssl.itunes.apple.com/a.m4a")
        self.assertEqual(out[0]["artist"], "A")

    def test_challenge_drops_unsafe_urls(self):
        out = server._clean_challenge_movies([{"title": "曲", "itunesId": "9", "previewUrl": "javascript:alert(1)",
                                               "appleUrl": "data:x"}])
        self.assertNotIn("previewUrl", out[0])
        self.assertNotIn("appleUrl", out[0])

    def test_movie_without_itunes_unchanged(self):
        out = server._clean_challenge_movies([{"title": "映画", "year": "2020", "filmarksId": "1"}])
        self.assertEqual(out[0], {"title": "映画", "year": "2020", "poster": "", "filmarksId": "1", "key": "f:1"})
        self.assertEqual(server._movie_meta({"title": "映画", "year": "2020"}),
                         {"title": "映画", "poster": "", "year": "2020", "filmarksId": ""})

    def test_meta_keeps_music_fields(self):
        meta = server._movie_meta({"title": "曲", "itunesId": "9", "artist": "A", "previewUrl": "https://a1.mzstatic.com/a.m4a"})
        self.assertEqual((meta["itunesId"], meta["artist"], meta["previewUrl"]), ("9", "A", "https://a1.mzstatic.com/a.m4a"))

    def test_url_allowlist(self):
        f = server._music_fields
        ok = {"itunesId": "9", "appleUrl": "https://music.apple.com/jp/album/1?i=9",
              "previewUrl": "https://audio-ssl.itunes.apple.com/x.m4a"}
        self.assertEqual(f(ok), ok)
        self.assertEqual(f({"appleUrl": "https://itunes.apple.com/jp/album/1"})["appleUrl"], "https://itunes.apple.com/jp/album/1")
        self.assertEqual(f({"previewUrl": "https://mzstatic.com/x.m4a"})["previewUrl"], "https://mzstatic.com/x.m4a")
        for bad in ({"appleUrl": "https://evil.com/music.apple.com"}, {"appleUrl": "http://music.apple.com/x"},
                    {"appleUrl": "https://music.apple.com.evil.com/x"}, {"appleUrl": "https://audio-ssl.itunes.apple.com/x"},
                    {"previewUrl": "https://evilmzstatic.com/x"}, {"previewUrl": "https://music.apple.com/x"},
                    {"previewUrl": "https://user@evil.com/a.mzstatic.com"}, {"itunesId": "12a"}, {"itunesId": "javascript:1"}):
            self.assertEqual(f(bad), {}, bad)

    def test_data_repo_guard(self):
        ok = server._data_repo_ok
        self.assertTrue(ok("cinema", "puriowing/tierlist-data"))
        self.assertFalse(ok("music", "puriowing/tierlist-data"))
        self.assertFalse(ok("music", "music-org/tierlist-data"))
        self.assertTrue(ok("music", "puriowing/tiari-music-data"))
        self.assertTrue(ok("music", "puriowing/Tiari-Music-Data"))

    def test_data_repo_guard_disables_remote(self):
        import subprocess, sys
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for repo, want in (("puriowing/tierlist-data", "False"), ("puriowing/tiari-music-data", "True")):
            env = dict(os.environ, TIARI_SITE="music", TIARI_DATA_DIR=tempfile.mkdtemp(), GITHUB_TOKEN="x", DATA_REPO=repo)
            r = subprocess.run([sys.executable, "-c", "import server; print(server.REMOTE_ON)"], cwd=root, env=env,
                               capture_output=True, text=True)
            self.assertEqual(r.stdout.strip(), want, r.stderr)
            self.assertEqual("警告" in r.stderr, want == "False")

    def test_music_demo_uses_songs(self):
        self.assertEqual(server.SITE["id"], "music")
        users = server._demo_users()
        self.assertTrue(users)
        self.assertTrue(all(k.startswith("s:") for u in users for k in u["ratings"]))
        chs = server._demo_challenges()
        self.assertGreaterEqual(len(chs), 3)
        for c in chs.values():
            self.assertTrue(all(m["key"].startswith("s:") and m.get("artist") for m in c["movies"]))
            self.assertTrue(c["entries"])


if __name__ == "__main__":
    unittest.main()
