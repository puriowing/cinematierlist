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
