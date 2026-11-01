import unittest
import itunes

TRACK = {"wrapperType": "track", "kind": "song", "trackId": 111, "trackName": "曲A",
         "artistName": "歌手", "collectionName": "アルバム", "artworkUrl100": "https://x/100x100bb.jpg",
         "releaseDate": "2024-05-01T07:00:00Z", "primaryGenreName": "J-Pop",
         "previewUrl": "https://p/a.m4a", "trackViewUrl": "https://music.apple.com/jp/album/1?i=111"}

class ITunesTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        orig = itunes.fetch_json
        self.addCleanup(setattr, itunes, "fetch_json", orig)
        def fake(url):
            self.calls.append(url)
            return {"results": [{"wrapperType": "artist", "artistName": "歌手"}, TRACK, dict(TRACK, kind="music-video")]}
        itunes.fetch_json = fake

    def test_song_shape(self):
        s = itunes.search_songs("曲A")[0]
        self.assertEqual(s["itunesId"], "111")
        self.assertEqual(s["year"], "2024")
        self.assertEqual(s["poster"], "https://x/600x600bb.jpg")
        self.assertEqual(s["genres"], ["J-Pop"])

    def test_only_songs(self):
        self.assertEqual(len(itunes.search_songs("曲A")), 1)

    def test_query_params(self):
        itunes.search_songs("a b")
        self.assertIn("country=JP", self.calls[0])
        self.assertIn("entity=song", self.calls[0])

    def test_artist_songs(self):
        r = itunes.artist_songs("5")
        self.assertEqual(r["artist"], "歌手")
        self.assertIn("id=5", self.calls[0])


class DedupeTest(unittest.TestCase):
    def test_same_song_keeps_earliest(self):
        rs = [dict(TRACK, trackId=3, collectionName="BEST", releaseDate="2030-01-01T00:00:00Z"),
              dict(TRACK, trackId=1, collectionName="シングル", releaseDate="2020-01-01T00:00:00Z"),
              dict(TRACK, trackId=2, trackName="曲Ａ ", artistName="歌手", releaseDate="2021-01-01T00:00:00Z")]
        out = itunes._songs(rs)
        self.assertEqual([s["itunesId"] for s in out], ["1"])
        self.assertEqual(out[0]["album"], "シングル")

    def test_versions_kept_separately(self):
        rs = [TRACK, dict(TRACK, trackId=2, trackName="曲A (Live)"), dict(TRACK, trackId=3, trackName="曲A - Remix")]
        self.assertEqual(len(itunes._songs(rs)), 3)

    def test_other_artist_kept(self):
        self.assertEqual(len(itunes._songs([TRACK, dict(TRACK, trackId=2, artistName="別の歌手")])), 2)


class RemasterTest(unittest.TestCase):
    SAME = ["曲A", "曲A (2019 Remaster)", "曲A - Remastered 2011", "曲A (リマスター)", "曲A［Remastered］",
            "曲A【リマスター版】", "曲A - 2011 Remastered Version", "曲A (Single Version)", "曲A (シングル・バージョン)",
            "曲A (Album ver.)", "曲A (Mono)", "曲A (Remastered) [Stereo]", "曲A (Original)"]
    OTHER = ["曲A (Live)", "曲A - Remix", "曲A (Acoustic ver.)", "曲A (Instrumental)", "曲A (Cover)", "曲A (TV size)",
             "曲A - From THE FIRST TAKE", "曲A (Demo)", "曲A (English ver.)", "曲A (Original Mix)"]

    def test_variants_collapse(self):
        self.assertEqual({itunes.song_title_norm(t) for t in self.SAME}, {"曲a"})

    def test_other_versions_stay(self):
        keys = [itunes.song_title_norm(t) for t in self.OTHER]
        self.assertNotIn("曲a", keys)
        self.assertEqual(len(set(keys)), len(keys))

    def test_dedupe_keeps_original(self):
        rs = [dict(TRACK, trackId=2, trackName="曲A (2019 Remaster)", releaseDate="2019-01-01T00:00:00Z"),
              dict(TRACK, trackId=1, releaseDate="1985-01-01T00:00:00Z"),
              dict(TRACK, trackId=3, trackName="曲A (Live)")]
        out = itunes._songs(rs)
        self.assertEqual([(s["itunesId"], s["title"]) for s in out], [("1", "曲A"), ("3", "曲A (Live)")])

    def test_long_title_fast(self):
        import time
        for t in ("a" * 100000, "曲 " + " (remaster)" * 10000, "x" + " - remastered 2011" * 6000 + "!"):
            st = time.perf_counter()
            itunes.song_title_norm(t)
            self.assertLess(time.perf_counter() - st, 0.5)

    def test_trailing_newline(self):
        self.assertEqual(itunes.song_title_norm("曲A (Remaster)\n"), "曲a")
        self.assertEqual(itunes.song_title_norm("  曲A - Remastered 2011 \n\t"), "曲a")


def _t(tid, artist, aid, album, cid, name=None):
    return dict(TRACK, trackId=tid, trackName=name or f"曲{tid}", artistName=artist, artistId=aid,
                collectionName=album, collectionId=cid)


class SearchAllTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        orig = itunes.fetch_json
        self.addCleanup(setattr, itunes, "fetch_json", orig)
        self.responses = {}

        def fake(url):
            self.calls.append(url)
            for k, v in self.responses.items():
                if k in url:
                    return {"results": v}
            return {"results": []}
        itunes.fetch_json = fake

    def test_derives_from_one_fetch(self):
        self.responses["entity=song"] = [
            _t(1, "歌手B", 20, "アルバムY", 200), _t(2, "歌手A", 10, "アルバムX", 100),
            _t(3, "歌手A", 10, "アルバムX", 100), _t(4, "歌手A feat. 歌手B", 10, "アルバムZ", 300),
            _t(5, "Various Artists", 99, "ベスト", 400), _t(6, "歌手B", 20, "アルバムY", 200),
            _t(7, "カバー歌手", 30, "カバー集", 500)]
        r = itunes.search_all("q")
        self.assertEqual(len(self.calls), 1)
        self.assertIn("entity=song", self.calls[0])
        self.assertEqual(r["artists"], [{"id": "10", "name": "歌手A"}, {"id": "20", "name": "歌手B"}])
        self.assertEqual([a["id"] for a in r["albums"]], ["200", "100", "300", "400", "500"])
        self.assertEqual(r["albums"][0]["title"], "アルバムY")
        self.assertEqual(r["albums"][0]["poster"], "https://x/600x600bb.jpg")
        self.assertEqual(len(r["songs"]), 7)
        self.assertNotIn("artistId", r["songs"][0])

    def test_caps(self):
        self.responses["entity=song"] = [_t(i * 2 + k, f"歌手{i}", i, f"盤{i}", 1000 + i, name=f"曲{i}-{k}")
                                         for i in range(1, 15) for k in (0, 1)]
        r = itunes.search_all("q")
        self.assertEqual((len(r["artists"]), len(r["albums"])), (3, 8))
        self.assertEqual(len(self.calls), 1)

    def test_fallback_album_search_when_no_songs(self):
        self.responses["entity=album"] = [{"collectionId": 7, "collectionName": "盤", "artistName": "歌手"}]
        r = itunes.search_all("q")
        self.assertEqual(len(self.calls), 2)
        self.assertIn("entity=album", self.calls[1])
        self.assertEqual(r["albums"][0]["id"], "7")
        self.assertEqual(r["artists"], [])
