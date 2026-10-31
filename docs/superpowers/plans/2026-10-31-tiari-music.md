# tiari for Music Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同じコードを `TIARI_SITE=cinema|music` で切り替え、映画版「tiari for Cinema」と曲のティアを作る「tiari for Music」を別サービスとして動かす。

**Architecture:** サイトごとの設定（名前・色・文言・機能のオン/オフ）を `sites.py` に置き、サーバーが `/site.js` と `/manifest.webmanifest` として配る。app.js は `window.TIARI_SITE` を読み、`W()`（文言）と `has()`（機能）で分岐する。音楽データは `itunes.py` が iTunes Search API から取得し、`/api/itunes/*` で返す。

**Tech Stack:** Python 3.12 標準ライブラリのみ（server.py）、素の JavaScript（app.js）、テストは `python3 -m unittest`。

**Spec:** `docs/superpowers/specs/2026-10-31-tiari-music-design.md`

## Global Constraints

- 追加ライブラリ禁止（Python 標準ライブラリのみ、フロントもビルドなし）。
- `TIARI_SITE` 未設定時は `cinema`。**映画版の動き・データは一切変えない。**
- 名前表記：`tiari for Cinema` / `tiari for Music`。
- iTunes は `country=JP`, `lang=ja_jp`。1分約20回の制限があるため結果を最低24時間キャッシュ。
- 曲の同一判定キー：`"i:" + itunesId`。
- 試聴・ジャケットを出す箇所には「Apple Music で聴く」リンク（`appleUrl`）を付ける。
- `data/` と `_debug_state.json` はコミットしない。コミットは毎回（フックで push される）。コミットメッセージ末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- コメントは最小限。

---

## 第1段階：切り替えの仕組みと tiari for Cinema

### Task 1: サイト設定 `sites.py`

**Files:**
- Create: `sites.py`
- Test: `tests/test_sites.py`

**Interfaces:**
- Produces: `get_site(name: str | None) -> dict`（キー: `id, name, fullName, description, themeColor, bgColor, features: list[str], words: dict[str,str]`）、`site_js(site) -> str`、`manifest(site) -> dict`

- [ ] **Step 1: テストを書く**

```python
import unittest
import sites

class SitesTest(unittest.TestCase):
    def test_default_is_cinema(self):
        self.assertEqual(sites.get_site(None)["id"], "cinema")
        self.assertEqual(sites.get_site("unknown")["id"], "cinema")

    def test_music(self):
        s = sites.get_site("music")
        self.assertEqual(s["fullName"], "tiari for Music")
        self.assertEqual(s["words"]["作品"], "曲")
        self.assertNotIn("watch", s["features"])

    def test_cinema_words_identity(self):
        self.assertEqual(sites.get_site("cinema")["words"], {})

    def test_site_js(self):
        js = sites.site_js(sites.get_site("music"))
        self.assertTrue(js.startswith("window.TIARI_SITE="))
        self.assertIn("tiari for Music", js)

    def test_manifest(self):
        m = sites.manifest(sites.get_site("music"))
        self.assertEqual(m["name"], "tiari for Music")
        self.assertEqual(m["theme_color"], sites.get_site("music")["themeColor"])
```

- [ ] **Step 2: 失敗を確認** — `python3 -m unittest tests.test_sites -v` → `ModuleNotFoundError: sites`
- [ ] **Step 3: 実装**

```python
import json

CINEMA_FEATURES = ["filmarks", "watch", "theater", "awards", "series", "coming",
                   "people", "recommend", "diagnosis", "genreTag", "yearAdd", "theaterFreq"]

SITES = {
    "cinema": {
        "id": "cinema", "name": "Tiari", "fullName": "tiari for Cinema",
        "description": "観た映画を好きな順に並べて、自分だけの映画ランキングを作れるツール",
        "themeColor": "#6d4aff", "bgColor": "#f6f3ff",
        "features": CINEMA_FEATURES, "words": {},
    },
    "music": {
        "id": "music", "name": "Tiari", "fullName": "tiari for Music",
        "description": "聴いた曲を好きな順に並べて、自分だけの音楽ランキングを作れるツール",
        "themeColor": "#e0457b", "bgColor": "#fff3f7",
        "features": ["itunes", "preview"],
        "words": {"作品": "曲", "映画": "音楽", "観た": "聴いた", "観たい": "聴きたい",
                  "鑑賞": "視聴", "監督": "アーティスト", "ポスター": "ジャケット", "公開年": "発売年"},
    },
}

def get_site(name):
    return SITES.get((name or "").strip().lower(), SITES["cinema"])

def site_js(site):
    return "window.TIARI_SITE=" + json.dumps(site, ensure_ascii=False) + ";"

def manifest(site):
    return {
        "id": "./", "name": site["fullName"], "short_name": site["fullName"],
        "description": site["description"], "lang": "ja",
        "start_url": "./?source=pwa", "scope": "./", "display": "standalone",
        "orientation": "portrait", "background_color": site["bgColor"],
        "theme_color": site["themeColor"], "categories": ["entertainment", "lifestyle"],
        "icons": [
            {"src": "icons/icon-192.png?v=4", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "icons/icon-512.png?v=4", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "icons/icon-maskable-512.png?v=4", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
        "shortcuts": [
            {"name": "統計を見る", "short_name": "統計", "url": "./?open=stats",
             "icons": [{"src": "icons/icon-192.png?v=4", "sizes": "192x192"}]},
        ],
    }
```

（`themeColor` の音楽版の値は第1段階の画面確認で芳賀さんに見てもらい確定する。）

- [ ] **Step 4: 成功を確認** — `python3 -m unittest tests.test_sites -v` → PASS
- [ ] **Step 5: コミット** — `git add sites.py tests/ && git commit -m "サイト設定（映画版・音楽版）を追加"`

### Task 2: サーバーで `/site.js`・`/manifest.webmanifest` を配り、データ置き場を分ける

**Files:**
- Modify: `server.py`（定数部 ~35行、`DATA_DIR` ~1134行、`Handler.do_GET` ~2637行）
- Test: `tests/test_server_site.py`

**Interfaces:**
- Consumes: `sites.get_site`, `sites.site_js`, `sites.manifest`
- Produces: `server.SITE`（dict）、環境変数 `TIARI_SITE`, `TIARI_DATA_DIR`

- [ ] **Step 1: テストを書く**（サーバーを別スレッドで起動し、HTTP で確認）

```python
import json, os, threading, unittest, urllib.request, tempfile
os.environ["TIARI_SITE"] = "music"
os.environ["TIARI_DATA_DIR"] = tempfile.mkdtemp()
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
```

- [ ] **Step 2: 失敗を確認** — `python3 -m unittest tests.test_server_site -v`
- [ ] **Step 3: 実装**
  - 先頭の import 群に `import sites`、定数部に `SITE = sites.get_site(os.environ.get("TIARI_SITE"))`。
  - `DATA_DIR = os.environ.get("TIARI_DATA_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")`
  - `do_GET` の先頭に追加：

```python
        if parsed.path == "/site.js":
            body = sites.site_js(SITE).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/manifest.webmanifest":
            body = json.dumps(sites.manifest(SITE), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/manifest+json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
```

  - `manifest.webmanifest` ファイルは削除（サーバー生成に一本化）。`sw.js` の CORE から `./manifest.webmanifest` は残してよい（サーバーが返す）。CORE に `./site.js` を追加し、`CACHE` を `ctl-cache-v11` に上げる。
- [ ] **Step 4: 成功を確認** — 両テスト PASS、`python3 -m unittest discover tests -v`
- [ ] **Step 5: コミット** — `git commit -am "サイト設定をサーバーから配る・データ置き場を環境変数で分けられるように"`

### Task 3: 画面側の切り替え口 `W()`・`has()` と tiari for Cinema の表示

**Files:**
- Modify: `index.html`（head、ヘッダーのブランド部 ~53-56行）、`app.js`（冒頭 ~12行）、`styles.css`

**Interfaces:**
- Consumes: `window.TIARI_SITE`
- Produces: app.js 内の `SITE`, `has(feature: string): boolean`, `W(text: string): string`（文中の対応語を一括置換）、`body[data-site]`

- [ ] **Step 1:** `index.html` の `<script src="app.js">` より前（head 内のテーマ判定スクリプトの直前）に `<script src="site.js"></script>` を追加。`<title>` を `tiari for Cinema` に（site.js 読み込み後に `document.title = TIARI_SITE.fullName` でも上書き）。
- [ ] **Step 2:** ワードマークの下に `<span class="site-sub" id="siteSub">for Cinema</span>` を追加し、styles.css に小さめ・控えめの文字スタイルを定義。
- [ ] **Step 3:** app.js 冒頭に追加：

```js
  const SITE = window.TIARI_SITE || { id: "cinema", fullName: "tiari for Cinema", features: [], words: {} };
  const has = (f) => (SITE.features || []).includes(f);
  const WORDS = Object.entries(SITE.words || {}).sort((a, b) => b[0].length - a[0].length);
  const W = (s) => WORDS.reduce((t, [a, b]) => t.split(a).join(b), String(s));
  document.documentElement.dataset.site = SITE.id;
  document.title = SITE.fullName;
  const subEl = document.getElementById("siteSub");
  if (subEl) subEl.textContent = SITE.fullName.replace(/^tiari\s*/i, "");
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = SITE.themeColor;
```

  （長い語から置換するので「観たい」が「観た」より先に処理される。）
- [ ] **Step 4: 画面確認** — `.claude/launch.json` に `cinema`（`python3 server.py 8000`）と `music`（環境変数 `TIARI_SITE=music TIARI_DATA_DIR=/tmp/tiari-music-data`, ポート8001）を登録し、preview_start で両方開く。映画版：見出しが「tiari for Cinema」、検索・年別追加・みんなのティア・お題が従来どおり動くこと、コンソールにエラーがないこと。
- [ ] **Step 5: コミット** — `git commit -am "tiari for Cinema の表示と、サイト切り替えの口（W・has）を追加"`

---

## 第2段階：音楽版の中心機能

### Task 4: iTunes 取得モジュール `itunes.py`

**Files:**
- Create: `itunes.py`
- Test: `tests/test_itunes.py`

**Interfaces:**
- Consumes: なし（`fetch_json` は差し替え可能にしてテストする）
- Produces: `search_songs(q: str, limit=30) -> list[Song]`、`artist_songs(artist_id: str, limit=200) -> {"artist": str, "songs": list[Song]}`、`album_songs(collection_id: str) -> {"album": str, "artist": str, "songs": list[Song]}`、`search_artists(q) -> list[{"id","name","genre"}]`、`search_albums(q) -> list[{"id","title","artist","poster","year"}]`
  - `Song = {"itunesId": str, "title": str, "artist": str, "album": str, "poster": str, "year": str, "genres": [str], "previewUrl": str, "appleUrl": str}`

- [ ] **Step 1: テストを書く**

```python
import unittest
import itunes

TRACK = {"wrapperType": "track", "kind": "song", "trackId": 111, "trackName": "曲A",
         "artistName": "歌手", "collectionName": "アルバム", "artworkUrl100": "https://x/100x100bb.jpg",
         "releaseDate": "2024-05-01T07:00:00Z", "primaryGenreName": "J-Pop",
         "previewUrl": "https://p/a.m4a", "trackViewUrl": "https://music.apple.com/jp/album/1?i=111"}

class ITunesTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
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
```

- [ ] **Step 2: 失敗を確認** — `python3 -m unittest tests.test_itunes -v`
- [ ] **Step 3: 実装**

```python
import json, urllib.parse, urllib.request

BASE = "https://itunes.apple.com"
COMMON = {"country": "JP", "lang": "ja_jp"}

def _default_fetch(url):
    import server
    return json.loads(server._fetch(url))

fetch_json = _default_fetch

def _url(path, **params):
    return f"{BASE}/{path}?" + urllib.parse.urlencode({**COMMON, **params})

def _song(r):
    return {
        "itunesId": str(r.get("trackId") or ""), "title": r.get("trackName") or "",
        "artist": r.get("artistName") or "", "album": r.get("collectionName") or "",
        "poster": (r.get("artworkUrl100") or "").replace("100x100bb", "600x600bb"),
        "year": (r.get("releaseDate") or "")[:4],
        "genres": [g for g in [r.get("primaryGenreName")] if g],
        "previewUrl": r.get("previewUrl") or "", "appleUrl": r.get("trackViewUrl") or "",
    }

def _songs(results):
    out, seen = [], set()
    for r in results:
        if r.get("wrapperType") == "track" and r.get("kind") == "song" and r.get("trackId") not in seen:
            seen.add(r.get("trackId"))
            out.append(_song(r))
    return out

def search_songs(q, limit=30):
    return _songs(fetch_json(_url("search", term=q, media="music", entity="song", limit=limit))["results"])

def search_artists(q, limit=10):
    rs = fetch_json(_url("search", term=q, media="music", entity="musicArtist", limit=limit))["results"]
    return [{"id": str(r["artistId"]), "name": r.get("artistName") or "", "genre": r.get("primaryGenreName") or ""}
            for r in rs if r.get("artistId")]

def search_albums(q, limit=20):
    rs = fetch_json(_url("search", term=q, media="music", entity="album", limit=limit))["results"]
    return [{"id": str(r["collectionId"]), "title": r.get("collectionName") or "", "artist": r.get("artistName") or "",
             "poster": (r.get("artworkUrl100") or "").replace("100x100bb", "600x600bb"),
             "year": (r.get("releaseDate") or "")[:4]} for r in rs if r.get("collectionId")]

def artist_songs(artist_id, limit=200):
    rs = fetch_json(_url("lookup", id=artist_id, entity="song", limit=limit))["results"]
    name = next((r.get("artistName") for r in rs if r.get("wrapperType") == "artist"), "")
    return {"artist": name, "songs": _songs(rs)}

def album_songs(collection_id):
    rs = fetch_json(_url("lookup", id=collection_id, entity="song"))["results"]
    head = next((r for r in rs if r.get("wrapperType") == "collection"), {})
    return {"album": head.get("collectionName") or "", "artist": head.get("artistName") or "", "songs": _songs(rs)}
```

  `server._fetch` は既存のキャッシュ（`_cache_read/_cache_write`）と間隔制御を通るので、同じURLの再取得は起きない。キャッシュの保持期間が24時間未満なら iTunes の URL だけ延ばす。
- [ ] **Step 4: 成功を確認**
- [ ] **Step 5: コミット** — `git commit -m "iTunes から曲・アーティスト・アルバムを取得するモジュールを追加"`

### Task 5: `/api/itunes/*` の窓口

**Files:**
- Modify: `server.py`（`do_GET`、Filmarks 窓口の並び ~2685行付近）
- Test: `tests/test_server_site.py` に追記（`itunes.fetch_json` を偽物に差し替えて確認）

**Interfaces:**
- Produces: `GET /api/itunes/search?q=&type=song|artist|album` → `{"results": [...]}`、`GET /api/itunes/artist?id=` → `artist_songs` の戻り値、`GET /api/itunes/album?id=` → `album_songs` の戻り値。失敗時 `{"error": "..."}` と 502。

- [ ] **Step 1: テスト追記**

```python
    def test_itunes_search(self):
        import itunes
        itunes.fetch_json = lambda url: {"results": [{"wrapperType": "track", "kind": "song", "trackId": 1, "trackName": "X"}]}
        r = json.loads(self.get("/api/itunes/search?q=X&type=song"))
        self.assertEqual(r["results"][0]["itunesId"], "1")
```

- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**（`do_GET` 内、`import itunes` を先頭に）

```python
        if parsed.path.startswith("/api/itunes/"):
            qs = urllib.parse.parse_qs(parsed.query)
            arg = lambda k: (qs.get(k) or [""])[0].strip()
            try:
                kind = parsed.path.rsplit("/", 1)[1]
                if kind == "search":
                    fn = {"artist": itunes.search_artists, "album": itunes.search_albums}.get(arg("type"), itunes.search_songs)
                    self._send_json({"results": fn(arg("q")) if arg("q") else []})
                elif kind == "artist":
                    self._send_json(itunes.artist_songs(arg("id")))
                elif kind == "album":
                    self._send_json(itunes.album_songs(arg("id")))
                else:
                    self._send_json({"error": "not found"}, 404)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc)}, 502)
            return
```

  `_poster_url`（`/api/img` の許可ホスト）に `mzstatic.com` を加える。
- [ ] **Step 4: 成功を確認**
- [ ] **Step 5: コミット**

### Task 6: 音楽版の曲追加画面（検索・アーティスト・アルバム）

**Files:**
- Modify: `app.js`（Filmarks 検索 ~3985-4014、人物からまとめて追加 ~4015-4281、`addMovie` ~987、`movieExists` ~1003）、`index.html`（検索欄の文言）

**Interfaces:**
- Consumes: `/api/itunes/*`、`has()`、`W()`
- Produces: 曲アイテム（Song の項目 + 既存の共通項目）、`movieKey` が `itunesId` を `"i:"+itunesId` として扱う

- [ ] **Step 1:** `movieKey`（~2067）の先頭に `if (m.itunesId) return "i:" + m.itunesId;` を追加。`movieExists` も `itunesId` 一致を優先。
- [ ] **Step 2:** 検索処理で `has("itunes")` のときは `/api/itunes/search?type=song` を呼び、結果カードに「アーティスト名・アルバム名」を表示。検索欄の上に「曲／アーティスト／アルバム」の切り替えを出す。
- [ ] **Step 3:** 「アーティスト」を選ぶと候補一覧 → 選択で `/api/itunes/artist?id=` を呼び、既存の「まとめて追加」グリッド（~6421 のユーティリティ）に曲を並べて選んで追加。「アルバム」も同様に `/api/itunes/album?id=`。
- [ ] **Step 4:** `addFilmsToWatchlist` 等の項目コピーに `itunesId, artist, album, previewUrl, appleUrl` を加える。
- [ ] **Step 5: 画面確認**（music の preview）— 「Mrs. GREEN APPLE」で検索→曲が出る、アーティストで200曲近く並ぶ、アルバムで収録曲が並ぶ、追加した曲がプールに入りドラッグできる、同じ曲は二重追加されない。映画版で検索が従来どおり動くことも確認。
- [ ] **Step 6: コミット**

### Task 7: 30秒試聴と「Apple Music で聴く」

**Files:**
- Modify: `app.js`（詳細パネル ~3241-3360、カード描画）、`styles.css`

- [ ] **Step 1:** `has("preview")` のとき、曲カードに小さな再生ボタンを重ねる。1つの `Audio` を使い回し、別の曲を押したら前の曲は止める。再生中はボタンを停止表示に。
- [ ] **Step 2:** 曲の詳細パネルに、試聴ボタンと「Apple Music で聴く」リンク（`appleUrl`、新しいタブ）を出す。映画の「いま観られる方法」欄は `has("watch")` のときだけ出す。
- [ ] **Step 3:** ドラッグ開始時は再生ボタンが反応しないように（クリックとドラッグの区別は既存のカード処理に合わせる）。
- [ ] **Step 4: 画面確認** — スマホ幅（resize_window mobile）でも押しやすいこと、再生・停止・切り替えが正しいこと。
- [ ] **Step 5: コミット**

### Task 8: 映画専用機能を隠す

**Files:**
- Modify: `app.js`（下表の各機能の入口）、`index.html`（該当ボタン）

| 機能 | フラグ | 主な場所 |
|---|---|---|
| 配信サービス案内 | `watch` | ~3280-3360 |
| 映画館・思い出の「劇場」 | `theater` | ~3417+ |
| 賞・コレクション | `awards` | ~7757-9011 |
| ドラマ/アニメシリーズ | `series` | ~6906-7130 |
| 公開予定 | `coming` | ~7442-7756 |
| 監督・出演者から追加 | `people` | ~4015-4281 |
| おすすめ | `recommend` | ~7131-7441 |
| 映画タイプ診断 | `diagnosis` | ~10343-10583 |
| ジャンル自動付与・ポスター差し替え | `genreTag` / `filmarks` | ~6103-6420 |
| 年別・ジャンル別の追加 | `yearAdd` | ~6421-6905 |
| 属性「映画館に行く頻度」 | `theaterFreq` | ~1530-1700 |

- [ ] **Step 1:** 各機能の入口（ボタン表示・メニュー項目・初期化処理）を `if (!has("xxx")) return;` または要素を `hidden` にする形で止める。初期化時に Filmarks を呼ぶ処理（ジャンル付与・ポスター差し替え・公開予定の取得）は音楽版で一切走らないこと。
- [ ] **Step 2: 画面確認** — 音楽版で上表のボタンが見えない、ネットワークに `/api/filmarks/` が1件も出ない（read_network_requests）。映画版はすべて見える。
- [ ] **Step 3: コミット**

### Task 9: 文言の切り替え

**Files:**
- Modify: `app.js`、`index.html`

- [ ] **Step 1:** 音楽版で使う画面（ティア本体・追加・詳細・みんなのティア・お題・シェア・統計・使い方・ログイン）にある文字列を `W("…")` で包む。index.html の静的な文言は、app.js 起動時に `[data-w]` を付けた要素の `textContent` を `W()` で置き換える。
- [ ] **Step 2:** シェア画像のハッシュタグを `SITE.id === "music" ? "#tiariMusic #音楽好きと繋がりたい" : 既存` に。
- [ ] **Step 3: 画面確認** — 音楽版の各画面に「映画」「作品」「観た」「監督」が残っていないこと（`get_page_text` で検索）。映画版の文言は変わらないこと。
- [ ] **Step 4: コミット**

---

## 第3段階：みんなのティア・お題の音楽対応

### Task 10: サーバー側の曲の同一判定とお題データ

**Files:**
- Modify: `server.py`（`_movie_key` ~1431、`_movie_meta`、`_clean_challenge_movies` ~2006、`DEMO_CHALLENGES` ~1932、`_demo_users` ~1476）
- Create: `demo_songs.json`
- Test: `tests/test_music_keys.py`

- [ ] **Step 1: テスト**

```python
import unittest, server

class MusicKeyTest(unittest.TestCase):
    def test_itunes_key(self):
        self.assertEqual(server._movie_key({"itunesId": "123", "title": "x"}), "i:123")

    def test_challenge_keeps_music_fields(self):
        out = server._clean_challenge_movies([{"title": "曲", "itunesId": "9", "artist": "A",
                                               "poster": "https://is1-ssl.mzstatic.com/a.jpg", "previewUrl": "https://p/a.m4a"}])
        self.assertEqual(out[0]["key"], "i:9")
        self.assertEqual(out[0]["artist"], "A")
```

- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装** — `_movie_key` 先頭に `iid = str(m.get("itunesId") or "").strip()` → あれば `"i:" + iid`。`_movie_meta` と `_clean_challenge_movies` に `itunesId, artist, previewUrl, appleUrl` を追加（各 `_s(..., 600)`）。`SITE["id"] == "music"` のときはデモのお題・デモユーザーを `demo_songs.json`（定番J-POP 40曲程度、iTunes から取得した実データ）から作る。
- [ ] **Step 4: 成功を確認**（既存テストも全部）
- [ ] **Step 5: 画面確認** — 音楽版で2アカウント作り、同じ曲を並べて「みんなのティア」「友だちと比べる」「お題」が曲で動くこと。
- [ ] **Step 6: コミット**

---

## 第4段階：公開

### Task 11: Render に音楽版を追加

**Files:**
- Modify: `render.yaml`、`README.md`

- [ ] **Step 1:** `render.yaml` に2つ目のサービスを追加：

```yaml
  - type: web
    name: tiari-music
    runtime: python
    plan: free
    region: singapore
    buildCommand: "true"
    startCommand: python3 server.py
    envVars:
      - key: PYTHON_VERSION
        value: 3.12.7
      - key: TIARI_SITE
        value: music
      - key: SECRET_KEY
        generateValue: true
      - key: GITHUB_TOKEN
        sync: false
      - key: DATA_REPO
        sync: false
      - key: ADMIN_USERS
        sync: false
      - key: ALLOW_REGISTER
        value: "1"
```

  既存の映画版サービスには `TIARI_SITE: cinema` を明記する。
- [ ] **Step 2:** README に音楽版の起動方法（`TIARI_SITE=music TIARI_DATA_DIR=./data-music python3 server.py 8001`）を追記。`.gitignore` に `data-music/` を追加。
- [ ] **Step 3: 芳賀さんにお願いする手順を案内** — ①GitHub で非公開リポジトリ `tiari-music-data` を作成 ②トークンの対象に追加 ③Render の Blueprint を同期し、`tiari-music` の `GITHUB_TOKEN` と `DATA_REPO=puriowing/tiari-music-data`、`ADMIN_USERS` を入力。
- [ ] **Step 4: 公開確認** — 音楽版URLで検索・追加・試聴・ログインが動くこと、映画版URLが従来どおり動くこと。
- [ ] **Step 5: コミット**
