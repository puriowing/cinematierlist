import os, tempfile, unittest
os.environ.setdefault("TIARI_SITE", "music")
os.environ.setdefault("TIARI_DATA_DIR", tempfile.mkdtemp())
import server


class MusicKeyTest(unittest.TestCase):
    def test_itunes_key(self):
        self.assertEqual(server._movie_key({"itunesId": "123", "title": "x"}), "i:123")

    def test_challenge_keeps_music_fields(self):
        out = server._clean_challenge_movies([{"title": "曲", "itunesId": "9", "artist": "A",
                                               "poster": "https://is1-ssl.mzstatic.com/a.jpg", "previewUrl": "https://p/a.m4a"}])
        self.assertEqual(out[0]["key"], "i:9")
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
        meta = server._movie_meta({"title": "曲", "itunesId": "9", "artist": "A", "previewUrl": "https://p/a.m4a"})
        self.assertEqual((meta["itunesId"], meta["artist"], meta["previewUrl"]), ("9", "A", "https://p/a.m4a"))

    def test_music_demo_uses_songs(self):
        self.assertEqual(server.SITE["id"], "music")
        users = server._demo_users()
        self.assertTrue(users)
        self.assertTrue(all(k.startswith("i:") for u in users for k in u["ratings"]))
        chs = server._demo_challenges()
        self.assertGreaterEqual(len(chs), 3)
        for c in chs.values():
            self.assertTrue(all(m["key"].startswith("i:") and m.get("artist") for m in c["movies"]))
            self.assertTrue(c["entries"])


if __name__ == "__main__":
    unittest.main()
