import unittest, urllib.parse
import itunes

TRACK = {"wrapperType": "track", "kind": "song", "trackId": 111, "trackName": "曲A",
         "artistName": "歌手", "collectionName": "アルバム", "artworkUrl100": "https://x/100x100bb.jpg",
         "releaseDate": "2024-05-01T07:00:00Z", "primaryGenreName": "J-Pop",
         "previewUrl": "https://p/a.m4a", "trackViewUrl": "https://music.apple.com/jp/album/1?i=111"}

class _Fresh(unittest.TestCase):
    def setUp(self):
        itunes._en_titles.clear()


class ITunesTest(unittest.TestCase):
    def setUp(self):
        itunes._en_titles.clear()
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


class DedupeTest(_Fresh):
    def test_same_song_keeps_earliest(self):
        rs = [dict(TRACK, trackId=3, collectionName="BEST", releaseDate="2030-01-01T00:00:00Z"),
              dict(TRACK, trackId=1, collectionName="シングル", releaseDate="2020-01-01T00:00:00Z"),
              dict(TRACK, trackId=2, trackName="曲Ａ ", artistName="歌手", releaseDate="2021-01-01T00:00:00Z")]
        out = itunes._songs(rs)
        self.assertEqual([s["itunesId"] for s in out], ["1"])
        self.assertEqual(out[0]["album"], "シングル")

    def test_versions_kept_separately(self):
        rs = [TRACK, dict(TRACK, trackId=2, trackName="曲A (Cover)"), dict(TRACK, trackId=3, trackName="曲A (Karaoke)")]
        self.assertEqual(len(itunes._songs(rs)), 3)

    def test_other_artist_kept(self):
        self.assertEqual(len(itunes._songs([TRACK, dict(TRACK, trackId=2, artistName="別の歌手")])), 2)


class RemasterTest(_Fresh):
    SAME = ["曲A", "曲A (2019 Remaster)", "曲A - Remastered 2011", "曲A (リマスター)", "曲A［Remastered］",
            "曲A【リマスター版】", "曲A - 2011 Remastered Version", "曲A (Single Version)", "曲A (シングル・バージョン)",
            "曲A (Album ver.)", "曲A (Mono)", "曲A (Remastered) [Stereo]", "曲A (Original)"]
    OTHER = ["曲A (Cover)", "曲A (カバー)", "曲A (Karaoke)", "曲A (オリジナル・カラオケ)", "曲A (Forever)", "曲A (Alive)", "曲A (Delivery)"]

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
        self.assertEqual([(s["itunesId"], s["title"]) for s in out], [("1", "曲A")])

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
        itunes._en_titles.clear()
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
        self.assertEqual(len(self.calls), 2)
        self.assertIn("entity=song", self.calls[0])
        self.assertIn("country=US", self.calls[1])
        self.assertEqual(r["artists"], [{"id": "20", "name": "歌手B"}, {"id": "10", "name": "歌手A"}])  # 一番上の曲のアーティストが先
        self.assertEqual([a["id"] for a in r["albums"]], ["200", "100", "300", "500"])
        self.assertEqual(r["albums"][0]["title"], "アルバムY")
        self.assertEqual(r["albums"][0]["poster"], "https://x/600x600bb.jpg")
        self.assertEqual(len(r["songs"]), 7)
        self.assertNotIn("artistId", r["songs"][0])

    def test_caps(self):
        self.responses["entity=song"] = [_t(i * 2 + k, f"歌手{i}", i, f"盤{i}", 1000 + i, name=f"曲{i}-{k}")
                                         for i in range(1, 15) for k in (0, 1)]
        r = itunes.search_all("q")
        self.assertEqual((len(r["artists"]), len(r["albums"])), (3, 8))
        self.assertEqual(len(self.calls), 2)

    def test_fallback_album_search_when_no_songs(self):
        self.responses["entity=album"] = [{"collectionId": 7, "collectionName": "盤", "artistName": "歌手"}]
        r = itunes.search_all("q")
        self.assertEqual(len(self.calls), 2)
        self.assertIn("entity=album", self.calls[1])
        self.assertEqual(r["albums"][0]["id"], "7")
        self.assertEqual(r["artists"], [])


class VersionTagParityTest(_Fresh):
    def test_js_matches_python(self):
        import json, os, re
        src = open(os.path.join(os.path.dirname(__file__), "..", "app.js"), encoding="utf-8").read()
        m = re.search(r'const VERSION_TAG_W = ((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+);', src)
        js = "".join(json.loads(p) for p in re.findall(r'"(?:[^"\\]|\\.)*"', m.group(1)))
        self.assertEqual(js, itunes._TAG)

    def test_mix_tags(self):
        for t in ["曲A (2019 Mix)", "曲A - 2021 Mix", "曲A (Mono Mix)", "曲A (Stereo Mix)", "曲A (2009 - Remaster)",
                  "曲A (2009 Digital Remaster)", "曲A (Mono;2009 Digital Remaster)", "曲A (2018ステレオ・ミックス)"]:
            self.assertEqual(itunes.song_title_norm(t), "曲a", t)
        for t in ["曲A (Cover)", "曲A (Karaoke)"]:
            self.assertNotEqual(itunes.song_title_norm(t), "曲a", t)

    def test_live_acoustic_etc_collapse(self):
        for t in ["曲A (Live)", "曲A - Live at Budokan 2019", "曲A (Live at 日本武道館)", "曲A (ライブ)", "曲A (Acoustic ver.)",
                  "曲A (アコースティック・ライブ・バージョン)", "曲A (Instrumental)", "曲A (Inst.)", "曲A (インストゥルメンタル)",
                  "曲A (TV size)", "曲A (TVサイズ)", "曲A - From THE FIRST TAKE", "曲A (Demo)", "曲A (デモ)",
                  "曲A (English ver.)", "曲A (イングリッシュ・バージョン)", "曲A (英語版)", "曲A (Live Remix)"]:
            self.assertEqual(itunes.song_title_norm(t), "曲a", t)
            self.assertTrue(itunes.is_variant(t), t)

    def test_cover_by_other_artist_stays_separate(self):
        rows = [TRACK, dict(TRACK, trackId=2, artistName="別の歌手", trackName="曲A"), dict(TRACK, trackId=3, trackName="曲A - From THE FIRST TAKE")]
        self.assertEqual([(s["artist"], s["title"]) for s in itunes._songs(rows)], [("歌手", "曲A"), ("別の歌手", "曲A")])

    def test_remix_edit_version_collapse(self):
        for t in ["曲A (Tofubeats Remix)", "曲A - 2015 Remix", "曲A (Remixed)", "曲A (リミックス)", "曲A (Extended Mix)",
                  "曲A - Club Mix", "曲A (Radio Mix)", "曲A (Original Mix)", "曲A (Radio Edit)", "曲A (Single Edit)",
                  "曲A (Edit)", "曲A (Taylor's Version)", "曲A (Re-Recorded)", "曲A (2019 Remix)"]:
            self.assertEqual(itunes.song_title_norm(t), "曲a", t)
            self.assertTrue(itunes.is_variant(t), t)
        self.assertFalse(itunes.is_variant("曲A (2009 - Remaster)"))
        self.assertFalse(itunes.is_variant("曲A"))

    def test_plain_preferred_over_remix_then_album_rules(self):
        rows = [dict(TRACK, trackId=1, trackName="曲A (Tofubeats Remix)", collectionName="曲A (Remixes) - EP", releaseDate="2010-01-01T00:00:00Z"),
                dict(TRACK, trackId=2, trackName="曲A", collectionName="BEST", releaseDate="2012-01-01T00:00:00Z"),
                dict(TRACK, trackId=3, trackName="曲A", collectionName="アルバム", releaseDate="2011-01-01T00:00:00Z")]
        self.assertEqual([(s["title"], s["album"]) for s in itunes._songs(rows)], [("曲A", "アルバム")])

    def test_remix_only_shown_without_tag(self):
        rows = [dict(TRACK, trackId=1, trackName="曲B (Club Mix)")]
        self.assertEqual([s["title"] for s in itunes._songs(rows)], ["曲B"])


def _b(tid, title, album, cid, count, comp_artist=None, date="1965-08-06T07:00:00Z"):
    r = dict(TRACK, trackId=tid, trackName=title, artistName="ビートルズ", artistId=1, collectionName=album,
             collectionId=cid, trackCount=count, releaseDate=date)
    if comp_artist:
        r["collectionArtistName"] = comp_artist
    return r


class OriginalAlbumTest(_Fresh):
    """ベスト盤・エディション違いより元のアルバムを選ぶ（ビートルズの実データに近い形）。"""

    def pick(self, rows):
        return {s["title"]: s["album"] for s in itunes._songs(rows)}

    def test_help_prefers_original_over_1(self):
        rows = [_b(1, "Help!", "1", 900, 27), _b(2, "Help! (2009 - Remaster)", "Help!", 500, 14),
                _b(3, "Help!", "The Beatles 1962-1966 (The Red Album)", 400, 26)]
        self.assertEqual(list(self.pick(rows).values()), ["Help!"])

    def test_in_my_life_rubber_soul(self):
        rows = [_b(1, "In My Life", "The Beatles 1962-1966", 400, 26), _b(2, "In My Life", "Rubber Soul", 600, 14),
                _b(3, "In My Life", "Love Songs (Best)", 300, 25), _b(4, "In My Life", "Now Hits", 200, 40, "Various Artists")]
        self.assertEqual(self.pick(rows), {"In My Life": "Rubber Soul"})

    def test_hey_jude_past_masters_only_without_original(self):
        rows = [_b(1, "Hey Jude", "1", 900, 27), _b(2, "Hey Jude (2009 - Remaster)", "The Beatles 1967-1970 (The Blue Album)", 800, 14),
                _b(3, "Hey Jude (2009 - Remaster)", "Past Masters, Vols. 1 & 2", 700, 15)]
        self.assertEqual(list(self.pick(rows).values()), ["Past Masters, Vols. 1 & 2"])
        rows.append(_b(4, "Hey Jude", "Hey Jude", 999, 10))
        self.assertEqual(list(self.pick(rows).values()), ["Hey Jude"])

    def test_original_beats_past_masters(self):
        rows = [_b(1, "Let It Be (Remastered 2009)", "Past Masters", 100, 15), _b(2, "Let It Be", "Let It Be", 900, 12)]
        self.assertEqual(list(self.pick(rows).values()), ["Let It Be"])

    def test_here_comes_the_sun_mix_merges_into_plain(self):
        rows = [_b(1, "Here Comes the Sun (2019 Mix)", "Abbey Road (Super Deluxe Edition) [2019 Remix & Remaster]", 300, 17),
                _b(2, "Here Comes the Sun (2019 Mix)", "Abbey Road (2019 Mix)", 200, 17),
                _b(3, "Here Comes the Sun", "Abbey Road", 900, 17)]
        self.assertEqual(self.pick(rows), {"Here Comes the Sun": "Abbey Road"})

    def test_guest_credit_merges_with_album_artist(self):
        rows = [dict(_b(1, "Get Back", "1", 900, 27), artistName="ビートルズ & ビリー・プレストン", collectionArtistName="ビートルズ"),
                _b(2, "Get Back (2009 Digital Remaster)", "Let It Be", 500, 12)]
        self.assertEqual(self.pick(rows), {"Get Back": "Let It Be"})

    def test_deterministic_regardless_of_order(self):
        rows = [_b(1, "Yesterday", "Help!", 500, 14), _b(2, "Yesterday", "1", 900, 27),
                _b(3, "Yesterday (2009 - Remaster)", "Help!", 501, 14)]
        self.assertEqual(itunes._songs(rows), itunes._songs(list(reversed(rows))))
        self.assertEqual(itunes._songs(rows)[0]["itunesId"], "1")

    def test_compilation_detection(self):
        comp = ["1", "The Beatles 1967-1970 (The Blue Album)", "Greatest Hits", "The Very Best of X", "ベスト・オブ・X",
                "Anthology 3", "Essentials", "シングルズ", "オールタイム・ベスト", "Mr.Children 1992-1995"]
        for t in comp:
            self.assertTrue(itunes.is_compilation({"collectionName": t, "trackCount": 27}), t)
        for t in ["Rubber Soul", "Help!", "Past Masters, Vols. 1 & 2", "Abbey Road (Remastered)", "Golden Hour", "Single Man", "Gold"]:
            self.assertFalse(itunes.is_compilation({"collectionName": t, "trackCount": 12}), t)
        self.assertFalse(itunes.is_compilation({"collectionName": "25", "trackCount": 11}))
        self.assertTrue(itunes.is_compilation({"collectionName": "X", "artistName": "a", "collectionArtistName": "Various Artists"}))
        self.assertFalse(itunes.is_compilation({"collectionName": "X", "artistName": "A feat. B", "collectionArtistName": "A"}))

    def test_album_section_drops_best_and_merges_editions(self):
        rows = [_b(1, "a", "1", 900, 27), _b(2, "b", "Abbey Road (Super Deluxe Edition) [2019 Remix & Remaster]", 300, 17),
                _b(3, "c", "Abbey Road (2019 Mix)", 200, 17), _b(4, "d", "Abbey Road", 950, 17),
                _b(5, "e", "Rubber Soul", 600, 14), _b(6, "f", "Now Hits", 10, 40, "Various Artists")]
        self.assertEqual([a["title"] for a in itunes._albums(rows, 8)], ["Abbey Road", "Rubber Soul"])

    def test_album_search_filtered(self):
        orig = itunes.fetch_json
        self.addCleanup(setattr, itunes, "fetch_json", orig)
        itunes.fetch_json = lambda u: {"results": [
            {"wrapperType": "collection", "collectionId": 1, "collectionName": "1", "artistName": "ビートルズ", "trackCount": 27},
            {"wrapperType": "collection", "collectionId": 2, "collectionName": "Abbey Road (Remastered)", "artistName": "ビートルズ", "trackCount": 17},
            {"wrapperType": "collection", "collectionId": 3, "collectionName": "Abbey Road (2019 Mix)", "artistName": "ビートルズ", "trackCount": 17}]}
        self.assertEqual([a["id"] for a in itunes.search_albums("beatles")], ["2"])
        itunes.fetch_json = lambda u: {"results": [
            {"collectionId": 3, "collectionName": "Abbey Road (2019 Mix)", "artistName": "ビートルズ", "trackCount": 17},
            {"collectionId": 2, "collectionName": "Abbey Road (Remastered)", "artistName": "ビートルズ", "trackCount": 19}]}
        self.assertEqual([a["title"] for a in itunes.search_albums("x")], ["Abbey Road (Remastered)"])


def _d(tid, title, album, cid, date, count=12):
    return dict(TRACK, trackId=tid, trackName=title, artistName="バンド", collectionName=album, collectionId=cid,
                trackCount=count, releaseDate=date + "T00:00:00Z")


class SpanCompilationTest(_Fresh):
    ENCORE = [_d(1, "花束", "アンコール", 9, "2011-04-06", 31), _d(2, "高嶺の花子さん", "アンコール", 9, "2013-06-26", 31),
              _d(3, "クリスマスソング", "アンコール", 9, "2015-11-18", 31), _d(4, "ハッピーエンド", "アンコール", 9, "2016-11-16", 31)]

    def test_wide_span_is_compilation(self):
        self.assertEqual(itunes.span_compilations(self.ENCORE), {9})

    def test_normal_album_not_compilation(self):
        rows = [_d(1, "a", "盤", 5, "2019-02-01"), _d(2, "b", "盤", 5, "2019-12-01"), _d(3, "c", "盤", 5, "2020-01-20")]
        self.assertEqual(itunes.span_compilations(rows), set())

    def test_thresholds(self):
        two_wide = [_d(1, "a", "X", 5, "2010-01-01"), _d(2, "b", "X", 5, "2016-06-01")]
        two_mid = [_d(1, "a", "X", 5, "2010-01-01"), _d(2, "b", "X", 5, "2015-01-01")]
        three_3y = [_d(1, "a", "X", 5, "2010-01-01"), _d(2, "b", "X", 5, "2011-01-01"), _d(3, "c", "X", 5, "2013-01-01")]
        self.assertEqual(itunes.span_compilations(two_wide), {5})
        self.assertEqual(itunes.span_compilations(two_mid), set())
        self.assertEqual(itunes.span_compilations(three_3y), set())

    def test_dedupe_prefers_original_over_span_best(self):
        rows = self.ENCORE + [_d(10, "花束", "blues", 20, "2012-03-14", 11), _d(11, "高嶺の花子さん - Single", "高嶺の花子さん - Single", 21, "2013-06-26", 2)]
        rows[-1]["trackName"] = "高嶺の花子さん"
        got = {s["title"]: s["album"] for s in itunes._songs(rows)}
        self.assertEqual(got["花束"], "blues")
        self.assertEqual(got["高嶺の花子さん"], "高嶺の花子さん - Single")
        self.assertEqual(got["クリスマスソング"], "アンコール")

    def test_album_section_drops_span_best(self):
        orig = itunes.fetch_json
        self.addCleanup(setattr, itunes, "fetch_json", orig)
        itunes.fetch_json = lambda u: {"results": self.ENCORE + [_d(10, "花束2", "blues", 20, "2012-03-14", 11)]}
        self.assertEqual([a["title"] for a in itunes.search_all("x")["albums"]], ["blues"])

    def test_span_ignored_for_past_masters_and_editions(self):
        rows = [_d(1, "Hey Jude", "Past Masters, Vols. 1 & 2", 7, "1968-08-26", 33), _d(2, "Love Me Do", "Past Masters, Vols. 1 & 2", 7, "1962-10-05", 33),
                _d(3, "Hey Jude", "The Beatles 1967-1970", 8, "1968-08-26", 14),
                _d(4, "Come Together (2019 Mix)", "Abbey Road (2019 Mix)", 9, "1969-09-26", 17),
                _d(5, "Something (Demo)", "Abbey Road (2019 Mix)", 9, "2019-09-27", 17)]
        got = {s["title"]: s["album"] for s in itunes._songs(rows)}
        self.assertEqual(got["Hey Jude"], "Past Masters, Vols. 1 & 2")
        self.assertEqual(itunes._album_rank(rows[3], itunes.span_compilations(rows))[0], False)

    def test_original_album_with_old_singles_not_compilation(self):
        rows = [_d(i, f"新曲{i}", "SOFTLY", 5, "2022-06-22", 15) for i in range(1, 6)] + \
               [_d(10 + i, f"シングル{i}", "SOFTLY", 5, d, 15) for i, d in enumerate(["2008-03-12", "2013-10-09", "2016-09-14", "2019-11-27"])]
        self.assertEqual(itunes.span_compilations(rows), set())


class ReviewFixTest(_Fresh):
    def test_collection_artist_only_explicit_various(self):
        self.assertFalse(itunes.is_compilation({"collectionName": "X", "artistName": "A", "collectionArtistName": "A & B"}))
        self.assertFalse(itunes.is_compilation({"collectionName": "X", "artistName": "ヨルシカ", "collectionArtistName": "Yorushika"}))
        for va in ["Various Artists", "V.A.", "VA", "ヴァリアス・アーティスト", "オムニバス", "Various"]:
            self.assertTrue(itunes.is_compilation({"collectionName": "X", "artistName": "A", "collectionArtistName": va}), va)

    def test_various_label_not_used_as_song_artist(self):
        self.assertEqual(itunes._song_artist({"artistName": "歌手", "collectionArtistName": "V.A."}), "歌手")

    def test_row_falls_back_when_all_filtered(self):
        rows = [{"collectionId": 1, "collectionName": "Greatest Hits", "artistName": "Ryan Adams", "trackCount": 16}]
        self.assertEqual([a["title"] for a in itunes._albums(rows, 8)], ["Greatest Hits"])
        rows.append({"collectionId": 2, "collectionName": "Gold", "artistName": "Ryan Adams", "trackCount": 15})
        self.assertEqual([a["title"] for a in itunes._albums(rows, 8)], ["Gold"])

    def test_plain_not_dropped_while_deluxe_remains(self):
        rows = [{"collectionId": 2, "collectionName": "Album (Deluxe Edition)", "artistName": "A", "trackCount": 20},
                {"collectionId": 1, "collectionName": "Album", "artistName": "A", "trackCount": 10},
                {"collectionId": 3, "collectionName": "Other", "artistName": "A", "trackCount": 10}]
        self.assertEqual([a["title"] for a in itunes._albums(rows, 8, comps={1})], ["Other"])
        self.assertEqual([a["title"] for a in itunes._albums(rows, 8)], ["Album", "Other"])

    def test_two_track_spread_only_deprioritizes(self):
        rows = [_d(1, "a", "盤", 5, "2005-01-01"), _d(2, "b", "盤", 5, "2015-01-01"),
                _d(3, "a", "シングル", 6, "2005-01-01", 2)]
        self.assertEqual({s["title"]: s["album"] for s in itunes._songs(rows)}["a"], "シングル")
        _, albums = itunes._derive(rows)
        self.assertIn("盤", [a["title"] for a in albums])

    def test_album_year_is_latest_track(self):
        rows = [_d(1, "a", "盤", 5, "2018-05-01"), _d(2, "b", "盤", 5, "2019-03-01")]
        _, albums = itunes._derive(rows)
        self.assertEqual(albums[0]["year"], "2019")

    def test_artist_name_tiebreak_deterministic(self):
        rows = [dict(TRACK, trackId=1, artistId=9, artistName="ab"), dict(TRACK, trackId=2, artistId=9, artistName="aa", trackName="x")]
        self.assertEqual(itunes._derive(rows)[0][0]["name"], "aa")
        self.assertEqual(itunes._derive(list(reversed(rows)))[0][0]["name"], "aa")


class ArtistRowTest(_Fresh):
    def test_top_song_artist_beats_cover_artists(self):
        rows = [_t(1, "優里", 1, "ドライフラワー - Single", 100, name="ドライフラワー")] + \
               [_t(10 + i, "BGM LAB", 2, f"カバー集{i}", 200 + i, name=f"ドライフラワー ({i})") for i in range(4)] + \
               [_t(20 + i, "オルゴール", 3, f"箱{i}", 300 + i, name=f"ドライフラワー [{i}]") for i in range(3)]
        names = [a["name"] for a in itunes._derive(rows, "ドライフラワー")[0]]
        self.assertEqual(names[0], "優里")

    def test_query_match_first(self):
        rows = [_t(1, "Other", 2, "盤", 100, name="a"), _t(2, "Other", 2, "盤", 100, name="b"),
                _t(3, "back number", 1, "盤2", 101, name="c")]
        self.assertEqual([a["name"] for a in itunes._derive(rows, "back number")[0]][:2], ["back number", "Other"])

    def test_various_still_excluded(self):
        rows = [_t(1, "Various Artists", 9, "盤", 100, name="a"), _t(2, "歌手", 1, "盤2", 101, name="b")]
        self.assertEqual([a["name"] for a in itunes._derive(rows, "various")[0]], ["歌手"])


class EnglishKeyTest(unittest.TestCase):
    """日本のストアのカタカナ名・英語名の混在は、米国ストアの曲名でまとめる。"""

    def setUp(self):
        itunes._en_titles.clear()
        self.calls, self.us = [], {}
        orig = itunes.fetch_json
        self.addCleanup(setattr, itunes, "fetch_json", orig)

        def fake(url):
            self.calls.append(url)
            if "country=US" not in url:
                raise AssertionError(url)
            ids = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["id"][0].split(",")
            return {"results": [{"wrapperType": "track", "trackId": int(i), "trackName": self.us[int(i)]}
                                for i in ids if int(i) in self.us]}
        itunes.fetch_json = fake

    def test_katakana_and_english_merge(self):
        self.us = {1: "Here Comes the Sun", 2: "Here Comes the Sun (2019 Mix)"}
        rows = [_b(1, "ヒア・カムズ・ザ・サン (2009 Digital Remaster)", "Abbey Road", 500, 17),
                _b(2, "Here Comes the Sun (2019 Mix)", "Abbey Road (Super Deluxe Edition)", 501, 40)]
        out = itunes._songs(rows)
        self.assertEqual([(s["title"], s["album"], s["keyTitle"]) for s in out],
                         [("ヒア・カムズ・ザ・サン", "Abbey Road", "Here Comes the Sun")])

    def test_not_in_us_store_keeps_jp_key(self):
        self.us = {1: "Let It Be"}
        rows = [_b(1, "レット・イット・ビー", "Let It Be", 500, 12), _b(2, "愛こそはすべて", "Magical Mystery Tour", 600, 11)]
        out = itunes._songs(rows)
        self.assertEqual([s["keyTitle"] for s in out], ["Let It Be", "愛こそはすべて"])

    def test_one_batched_lookup_and_memory_cache(self):
        rows = [_b(i, f"曲{i}", "盤", 500, 200) for i in range(1, 201)]
        itunes._songs(rows)
        self.assertEqual(len(self.calls), 2)
        itunes._songs(rows)
        self.assertEqual(len(self.calls), 2)

    def test_lookup_failure_falls_back(self):
        def boom(url):
            raise OSError("down")
        itunes.fetch_json = boom
        out = itunes._songs([_b(1, "レット・イット・ビー", "Let It Be", 500, 12)])
        self.assertEqual(out[0]["keyTitle"], "レット・イット・ビー")
        self.assertEqual(itunes._en_titles, {})

    def test_clean_title(self):
        self.assertEqual(itunes.clean_title("All You Need Is Love (2009 - Remaster)"), "All You Need Is Love")
        self.assertEqual(itunes.clean_title("Ｈｅｌｌｏ (Remastered)"), "Ｈｅｌｌｏ")
        self.assertEqual(itunes.clean_title("夜に駆ける"), "夜に駆ける")
        self.assertEqual(itunes.clean_title("曲A (Cover)"), "曲A (Cover)")

    def test_us_romaji_split_still_merged_by_jp_title(self):
        self.us = {1: "Yoru ni Kakeru", 2: "夜に駆ける"}
        rows = [dict(TRACK, trackId=1, trackName="夜に駆ける", collectionName="THE BOOK", collectionId=10),
                dict(TRACK, trackId=2, trackName="夜に駆ける", collectionName="夜に駆ける - Single", collectionId=11)]
        self.assertEqual(len(itunes._songs(rows)), 1)

    def test_more_remaster_tags(self):
        for t in ["曲A (Remastering 2022)", "曲A ('09 New Remaster)", "曲A (2023 NEW REMASTER)"]:
            self.assertEqual(itunes.song_title_norm(t), "曲a", t)
            self.assertFalse(itunes.is_variant(t), t)
        self.assertEqual(itunes.song_title_norm("Let It Be (Apple Studio - Remastered)"), "letitbe")
        self.assertTrue(itunes.is_variant("Let It Be (Apple Studio - Remastered)"))
        self.assertNotEqual(itunes.song_title_norm("曲A (Cover - Remastered)"), "曲a")

    def test_us_lookup_urls_digits_and_chunks(self):
        urls = itunes.us_lookup_urls([3, "4", "x1", "4", 5] + list(range(100, 400)))
        self.assertEqual(urls[0][1].split("&")[0], "https://itunes.apple.com/lookup?id=3%2C4%2C5%2C100" + "".join(f"%2C{i}" for i in range(101, 247)))
        self.assertEqual([len(p) for p, _ in urls], [150, 150, 3])
        self.assertTrue(all(u.endswith("&country=US") for _, u in urls))

    def test_device_data_not_cached(self):
        self.us = {1: "Let It Be"}
        orig = itunes.fetch_json
        itunes.fetch_json = lambda u: dict(orig(u), _from_device=True)
        out = itunes._songs([_b(1, "レット・イット・ビー", "Let It Be", 500, 12)])
        self.assertEqual(out[0]["keyTitle"], "Let It Be")
        self.assertEqual(itunes._en_titles, {})
