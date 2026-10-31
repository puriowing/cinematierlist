#!/usr/bin/env python3
"""Tiari 用のローカルサーバー。

静的ファイル配信に加えて、Filmarks を代理取得して作品の検索結果・ポスター・
監督/出演などを返す API (/api/filmarks/*) を提供します。ブラウザから直接
取得すると CORS でブロックされるため、このサーバーが仲介します。

使い方:
    python3 server.py
    → ブラウザで http://localhost:8000 を開く

追加ライブラリは不要です（Python 標準ライブラリのみ）。
"""

import base64
import errno
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import sites

PORT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else int(os.environ.get("PORT", "8000"))
# 既定で全インターフェースを待受け、同じネットワーク/ Tailscale の他端末（スマホ）から
# 到達できるようにする。ローカル専用に戻したい場合は HOST=127.0.0.1 を指定する。
HOST = os.environ.get("HOST", "0.0.0.0")
SITE = sites.get_site(os.environ.get("TIARI_SITE"))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " \
     "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"

RE_TAGS = re.compile(r"<[^>]+>")

MAX_CREDITS = 80  # 一度に取得する credits の最大件数


def _clean(text):
    """HTML タグを除去し、実体参照を戻して前後空白を除く。"""
    import html as _html
    return _html.unescape(RE_TAGS.sub("", text)).strip()


def _poster_url(url):
    """ポスターURLを正規化する。
    - // 始まりは https 補完
    - noimg プレースホルダは空文字に
    - CDNはCORS非対応の可能性があるためローカルプロキシ経由に
    """
    if not url:
        return ""
    if url.startswith("//"):
        url = "https:" + url
    if "noimg" in url:
        return ""
    return "/api/img?u=" + urllib.parse.quote(url, safe="")


# ---------------------------------------------------------------------------
# 取得の行儀を良くするための「ディスクキャッシュ」と「レート制限」。
#   - 一度取得したページはローカルに保存し、TTL 内は再取得しない
#     （同じ年・人物・作品を開き直しても相手サーバーに再アクセスしない）
#   - 同一ホストへの最小間隔と同時実行数を制限し、瞬間的なバーストを避ける
# 環境変数で調整可能: FETCH_MIN_GAP（秒）, FETCH_MAX_CONCURRENCY, FETCH_CACHE=0 で無効
# ---------------------------------------------------------------------------
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "cache")
FETCH_MIN_GAP = float(os.environ.get("FETCH_MIN_GAP", "0.1"))       # 同一ホストへの最小間隔
FETCH_MAX_CONCURRENCY = int(os.environ.get("FETCH_MAX_CONCURRENCY", "6"))
FETCH_CACHE = os.environ.get("FETCH_CACHE", "1") != "0"
_rate_lock = threading.Lock()
_last_req = {}                                    # host -> 最終リクエスト時刻
_fetch_sem = threading.Semaphore(FETCH_MAX_CONCURRENCY)


def _cache_ttl(url):
    """URL の種類ごとにキャッシュの有効期間（秒）を返す。"""
    if "itunes.apple.com" in url:
        return 24 * 3600
    if "/search/" in url:
        return 6 * 3600           # 検索結果は短め
    if "/list/" in url:
        return 24 * 3600          # 年別・ジャンル別・賞リストは1日
    if "/coming/" in url or "/now/" in url:
        return 3 * 3600           # 公開スケジュールは短め
    if any(s in url for s in ("/movie/", "/movies/", "/people/", "/person/")):
        return 7 * 24 * 3600      # 作品・人物ページはほぼ不変なので長め
    return 24 * 3600


def _cache_file(url):
    hh = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, hh + ".html")


def _cache_read(url):
    if not FETCH_CACHE:
        return None
    path = _cache_file(url)
    try:
        if time.time() - os.path.getmtime(path) < _cache_ttl(url):
            with open(path, encoding="utf-8") as f:
                return f.read()
    except Exception:  # noqa: BLE001
        pass
    return None


def _cache_write(url, text):
    if not FETCH_CACHE:
        return
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        path = _cache_file(url)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001
        pass


def _throttle(host):
    """同一ホストへの連続アクセスに最小間隔を空ける（礼儀としてのレート制限）。"""
    with _rate_lock:
        now = time.time()
        wait = FETCH_MIN_GAP - (now - _last_req.get(host, 0.0))
        if wait > 0:
            time.sleep(wait)
        _last_req[host] = time.time()


def _fetch(url, use_cache=True):
    cached = _cache_read(url) if use_cache else None
    if cached is not None:
        return cached
    host = urllib.parse.urlparse(url).netloc
    with _fetch_sem:                 # 同時実行数を制限
        _throttle(host)             # 最小間隔を確保
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode("utf-8", errors="replace")
    if use_cache:
        _cache_write(url, text)
    return text


def _prefetch(urls):
    """複数ページを並列に取得してキャッシュに載せておく（後続の逐次処理を速くする）。"""
    urls = [u for u in urls if _cache_read(u) is None]
    if len(urls) < 2:
        return
    def one(u):
        try:
            _fetch(u)
        except Exception:  # noqa: BLE001
            pass
    with ThreadPoolExecutor(max_workers=FETCH_MAX_CONCURRENCY) as ex:
        list(ex.map(one, urls))


# 画質・上映形式・言語違いだけの再上映版（4K/リマスター/IMAX/吹替 等）は選択肢から外す。
# ディレクターズ・カットや完全版など本編内容が変わる版は残す。
RE_REISSUE = re.compile(
    r"(?<=[^\s　])[\s　【〈＜<(（\[‐\-—–／/:：]*"
    r"(?<![A-Za-z])(?:[248]K(?![a-z])|(?:デジタル|HD|新)?・?(?:リマスター|レストア|修復)|"
    r"IMAX|ドルビー|Dolby|4DX|MX4D|ScreenX|3D版|3Dリマスター|"
    r"(?:日本語)?吹替|字幕版|ニュープリント|(?:応援|爆音|極上音響|発声)上映)",
    re.IGNORECASE,
)
RE_CONTENT_CHANGE = re.compile(
    r"ディレクターズ|カット|完全版|完全新作|特別編|特別版|エクステンデッド|エディション|"
    r"無修正|究極版|編集|アルティメット|コンプリート|インターナショナル版|リファイン|未公開|最終版"
)


def _is_reissue(title):
    t = unicodedata.normalize("NFKC", title or "")
    if not RE_REISSUE.search(t):
        return False
    return not RE_CONTENT_CHANGE.search(t.replace("完全修復", ""))


# Filmarks 年別ページ用（JSON-LD の ItemList とポスター img）
RE_FM_ITEM = re.compile(
    r'"position":(\d+),"url":"https://filmarks\.com/movies/(\d+)","name":"((?:[^"\\]|\\.)*)"'
)
RE_FM_POSTER = re.compile(
    r'<img alt="([^"]*)"[^>]*?src="(https://[^"]+cloudfront[^"]+/variants/[^"]+\.(?:jpg|jpeg|png))"'
)


def _parse_filmarks_page(html_text, year):
    """Filmarks の一覧ページ（年別・ジャンル別）1枚を解析して作品リストを返す。
    year=None の場合は年を空文字にする（ジャンル別ページは製作年を持たないため）。
    """
    # ポスター: alt(作品名) -> 画像URL
    posters = {}
    for m in RE_FM_POSTER.finditer(html_text):
        alt = _clean(m.group(1))
        if alt and alt not in posters:
            posters[alt] = m.group(2)

    year_str = "" if year is None else str(year)
    items = []
    for m in RE_FM_ITEM.finditer(html_text):
        fid = m.group(2)
        try:
            name = json.loads('"' + m.group(3) + '"')  # JSONエスケープを戻す
        except Exception:  # noqa: BLE001
            name = _clean(m.group(3))
        name = name.strip()
        if not name or _is_reissue(name):
            continue
        items.append({
            "id": fid,
            "title": name,
            "year": year_str,
            "poster": _poster_url(posters.get(name, "")),
            "url": f"https://filmarks.com/movies/{fid}",
        })
    return items


# Filmarks 年別リストビュー用（作品ごとに上映日=公開日を持つ）
RE_FM_Y_ID = re.compile(r"movie_id&quot;:(\d+)")
RE_FM_Y_TITLE = re.compile(r'cassette__title">([^<]+)</h3>')
RE_FM_Y_DATE = re.compile(r"上映日：</h4><span>(\d{4})年(?:(\d{1,2})月(\d{1,2})日)?")
RE_FM_Y_POSTER = re.compile(
    r'src="(https://[^"]+cloudfront[^"]+/variants/[^"]+\.(?:jpg|jpeg|png))"'
)


def _parse_filmarks_year_list(html_text, year):
    """Filmarks の年別リストビュー（上映日つき）1ページを解析する。
    各作品: {id, title, year, date, poster, url}
    year は製作年（選択した年）で固定。date は上映日=公開日 (YYYY-MM-DD) で、
    クライアント側で「公開が早い順」に並べるために使う（無い場合は空文字）。
    """
    items = []
    for chunk in html_text.split("js-cassette")[1:]:
        mid = RE_FM_Y_ID.search(chunk)
        tm = RE_FM_Y_TITLE.search(chunk)
        if not mid or not tm:
            continue
        title = _clean(tm.group(1))
        if not title or _is_reissue(title):
            continue
        dm = RE_FM_Y_DATE.search(chunk)
        date = ""
        if dm and dm.group(2) and dm.group(3):
            date = f"{dm.group(1)}-{int(dm.group(2)):02d}-{int(dm.group(3)):02d}"
        pm = RE_FM_Y_POSTER.search(chunk)
        items.append({
            "id": mid.group(1),
            "title": title,
            "year": str(year),
            "date": date,
            "poster": _poster_url(pm.group(1)) if pm else "",
            "url": f"https://filmarks.com/movies/{mid.group(1)}",
        })
    return items


def filmarks_year(year, start=1, pages=3):
    """Filmarks の年別リストビュー (人気順) を [start, start+pages) の範囲で取得する。
    その年の「製作年」ページなので、再公開に左右されず原年で揃う。
    各作品に上映日(date)を付与し、クライアント側で公開が早い順に並べられるようにする。
    「もっと見る」で続きを辿れるよう、ページ範囲を指定して取得できる。
    返り値: (results, has_more)  results 各要素: {title, year, date, poster, url}
    has_more=False は「これ以上ページが無い」ことを表す。
    """
    decade = f"{(int(year) // 10) * 10}s"
    results = []
    seen = set()
    has_more = True
    _prefetch([f"https://filmarks.com/list/year/{decade}/{year}?view=list" + ("" if pg == 1 else f"&page={pg}") for pg in range(start, start + pages)])
    for page in range(start, start + pages):
        url = f"https://filmarks.com/list/year/{decade}/{year}?view=list"
        if page > 1:
            url += f"&page={page}"
        try:
            html_text = _fetch(url)
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 410):
                has_more = False
                break
            raise
        items = _parse_filmarks_year_list(html_text, year)
        if not items:
            has_more = False
            break
        for it in items:
            if it["id"] in seen:
                continue
            seen.add(it["id"])
            results.append({k: it[k] for k in ("id", "title", "year", "date", "poster", "url")})
    return results, has_more


def filmarks_release_year(year, start=1, pages=3):
    """「公開年」ベースの一覧を取得する。
    Filmarks は映画の一覧を製作年でしか持たないため、製作年 [year .. year-LOOKBACK] の
    リストビューを取得し、各作品の上映日（＝オリジナルの劇場公開日）の年が `year` と
    一致するものだけを採用する。これにより：
      - 洋画など「製作年と公開年がずれる作品」も正しい公開年で拾える
        （海外製作→数年後に日本公開、映画祭経由の遅れ公開なども含む）
      - リバイバル上映があっても、Filmarks が持つオリジナルの上映日で判定するため
        再公開年ではなくオリジナル公開年で扱われる
    返り値: (results, has_more)  各要素: {title, year(=公開年), date, poster, url}
    """
    year = int(year)
    # 主軸は「製作年＝公開年」のリスト。ここを深くページングして件数を稼ぐ。
    # それに加えて、製作から日本公開まで遅れる作品（洋画・映画祭経由など。
    # 例: 2025年製作→2026年日本公開）を拾うため、過去の製作年も横断する。
    # 遅れ公開作は過去製作年リストの中に散らばっているので、直近の年ほど深く辿る
    # （delta が小さい年ほど該当作が多く、上位ページに集中するため）。
    # 全年を毎バッチ辿ると遅いので、この横断は「初回リクエスト(start==1)」のみ行う。
    CROSS_PAGES_BY_DELTA = {1: 15, 2: 10, 3: 7, 4: 5, 5: 3}
    last_page = start + pages - 1

    # (製作年, ページ) タスクを組み立てる
    tasks = [(year, page) for page in range(start, start + pages)]
    if start == 1:
        for d, depth in CROSS_PAGES_BY_DELTA.items():
            for page in range(1, depth + 1):
                tasks.append((year - d, page))

    def fetch_page(task):
        py, page = task
        decade = f"{(py // 10) * 10}s"
        url = f"https://filmarks.com/list/year/{decade}/{py}?view=list"
        if page > 1:
            url += f"&page={page}"
        try:
            items = _parse_filmarks_year_list(_fetch(url), py)
            return (py, page, items, "ok")
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 410):
                return (py, page, [], "end")  # リスト末尾（これ以上ページ無し）
            return (py, page, [], "err")       # 一時的なサーバーエラー
        except Exception:
            return (py, page, [], "err")       # DNS 一時失敗・タイムアウト等

    with ThreadPoolExecutor(max_workers=12) as ex:
        fetched = list(ex.map(fetch_page, tasks))

    results = []
    seen = set()
    # 続きの有無は主軸年（製作年＝公開年）の末尾ページで判断する。
    # 作品が残っていれば当然続きあり。取得失敗(err)のときも「まだ不明」として
    # 続き扱いにし、「もっと見る」で再取得できるようにする（末尾404のときだけ終了）。
    main_has_more = False
    for py, page, items, st in fetched:
        if py == year and page == last_page and (items or st == "err"):
            main_has_more = True
    for _py, _page, items, _st in fetched:
        for it in items:
            date = it.get("date", "")
            # 上映日の年。日付が無い作品は「製作年＝選択年」のときのみ採用
            rel_year = date[:4] if date else (str(year) if _py == year else "")
            if rel_year != str(year):
                continue
            if it["id"] in seen:
                continue
            seen.add(it["id"])
            results.append({
                "id": it["id"],
                "title": it["title"],
                "year": str(year),   # 公開年（オリジナル）
                "date": date,
                "poster": it["poster"],
                "url": it["url"],
            })
    return results, main_has_more


def filmarks_genre(genre_id, start=1, pages=3):
    """Filmarks のジャンル別ページ (人気順) を [start, start+pages) の範囲で取得する。
    1ページ約36件。「もっと見る」で続きを辿れるよう、ページ範囲を指定して取得できる。
    返り値: (results, has_more)  results 各要素: {title, year, poster, url}
    """
    results = []
    seen = set()
    has_more = True
    _prefetch([f"https://filmarks.com/list/genre/{genre_id}" + ("" if pg == 1 else f"?page={pg}") for pg in range(start, start + pages)])
    for page in range(start, start + pages):
        url = f"https://filmarks.com/list/genre/{genre_id}"
        if page > 1:
            url += f"?page={page}"
        try:
            html_text = _fetch(url)
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 410):
                has_more = False
                break
            raise
        items = _parse_filmarks_page(html_text, None)
        if not items:
            has_more = False
            break
        new_in_page = 0
        for it in items:
            if it["id"] in seen:
                continue
            seen.add(it["id"])
            new_in_page += 1
            results.append({k: it[k] for k in ("id", "title", "year", "poster", "url")})
        if new_in_page == 0:
            has_more = False
            break
    return results, has_more


def filmarks_coming(start=1, pages=4):
    """Filmarks の「公開予定」一覧 (/list/coming) を上映日の早い順に取得する。
    1ページ約36件。「もっと見る」で続きを辿れるよう、ページ範囲を指定できる。
    返り値: (results, has_more)  各要素: {id, title, year, date(上映日), poster, url}
    """
    results = []
    seen = set()
    has_more = True
    _prefetch(["https://filmarks.com/list/coming" + ("" if pg == 1 else f"?page={pg}") for pg in range(start, start + pages)])
    for page in range(start, start + pages):
        url = "https://filmarks.com/list/coming"
        if page > 1:
            url += f"?page={page}"
        try:
            html_text = _fetch(url)
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 410):
                has_more = False
                break
            raise
        # 上映日つきのリスト表示（年別一覧と同じマークアップ）としてパースする
        items = _parse_filmarks_year_list(html_text, "")
        if not items:
            has_more = False
            break
        new_in_page = 0
        for it in items:
            if it["id"] in seen:
                continue
            seen.add(it["id"])
            new_in_page += 1
            date = it.get("date", "")
            results.append({
                "id": it["id"],
                "title": it["title"],
                "year": date[:4] if date else "",
                "date": date,
                "poster": it["poster"],
                "url": it["url"],
            })
        if new_in_page == 0:
            has_more = False
            break
    return results, has_more


def filmarks_award(path, start=1, pages=3):
    """Filmarks の映画賞ページ (人気順) を [start, start+pages) の範囲で取得する。
    path は "1/1"（賞ID/部門ID）または "1"（賞ID）。1ページ約36件。
    返り値: (results, has_more)  results 各要素: {title, year, poster, url}
    """
    results = []
    seen = set()
    has_more = True
    _prefetch([f"https://filmarks.com/list/award/{path}" + ("" if pg == 1 else f"?page={pg}") for pg in range(start, start + pages)])
    for page in range(start, start + pages):
        url = f"https://filmarks.com/list/award/{path}"
        if page > 1:
            url += f"?page={page}"
        try:
            html_text = _fetch(url)
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 410):
                has_more = False
                break
            raise
        items = _parse_filmarks_page(html_text, None)
        if not items:
            has_more = False
            break
        new_in_page = 0
        for it in items:
            if it["id"] in seen:
                continue
            seen.add(it["id"])
            new_in_page += 1
            results.append({k: it[k] for k in ("id", "title", "year", "poster", "url")})
        if new_in_page == 0:
            has_more = False
            break
    return results, has_more


# Filmarks 検索ページ用（js-cassette カード）
RE_FM_S_ID = re.compile(r"movie_id&quot;:(\d+)")
RE_FM_S_TITLE = re.compile(r'p-content-cassette__title">([^<]*)</h3>')
RE_FM_S_POSTER = re.compile(
    r'<img alt="[^"]*"[^>]*?src="(https://[^"]+cloudfront[^"]+/variants/[^"]+\.(?:jpg|jpeg|png))"'
)
RE_FM_S_YEAR = re.compile(r"\u4e0a\u6620\u65e5\uff1a</h4><span>(\d{4})\u5e74")


def filmarks_search(query, limit=20):
    """Filmarks のタイトル検索結果を返す。ポスターが安定して付くのが利点。
    返す各要素: {id, title, year, poster, url}
    """
    q = urllib.parse.quote(query, safe="")
    html_text = _fetch(f"https://filmarks.com/search/movies?q={q}")
    results = []
    seen = set()
    for chunk in html_text.split('class="js-cassette"')[1:]:
        idm = RE_FM_S_ID.search(chunk)
        tm = RE_FM_S_TITLE.search(chunk)
        if not idm or not tm:
            continue
        fid = idm.group(1)
        if fid in seen:
            continue
        seen.add(fid)
        title = _clean(tm.group(1))
        if not title or _is_reissue(title):
            continue
        pm = RE_FM_S_POSTER.search(chunk)
        poster = _poster_url(pm.group(1)) if pm else ""
        ym = RE_FM_S_YEAR.search(chunk)
        results.append({
            "id": fid,
            "title": title,
            "year": ym.group(1) if ym else "",
            "poster": poster,
            "url": f"https://filmarks.com/movies/{fid}",
        })
        if len(results) >= limit:
            break
    return results


# ドラマ・アニメ（シリーズ単位で登録）。ID は "d<シリーズ>-<代表シーズン>" / "a<…>-<…>"
SERIES_PATH = {"drama": "dramas", "anime": "animes"}
SERIES_PREFIX = {"drama": "d", "anime": "a"}
RE_SERIES_FID = re.compile(r"^([da])(\d+)-(\d+)$")
RE_FM_S_SERIES = re.compile(r"(drama|anime)_series_id&quot;:(\d+),&quot;(?:drama|anime)_season_id&quot;:(\d+)")
RE_FM_S_POSTER_ANY = re.compile(
    r'<img alt="[^"]*"[^>]*?src="(https://[^"]+cloudfront[^"]+/variants/[^"]+)"'
)
RE_FM_S_DATE = re.compile(r"公開日：</h4><span>(\d{4})年(\d{2})月(?:(\d{2})日)?")


def _series_url(fid):
    m = RE_SERIES_FID.match(str(fid or ""))
    if not m:
        return ""
    path = "dramas" if m.group(1) == "d" else "animes"
    return f"https://filmarks.com/{path}/{m.group(2)}/{m.group(3)}"


def _filmarks_ld_season(html_text):
    for m in RE_LD_JSON.finditer(html_text):
        try:
            data = json.loads(m.group(1))
        except Exception:  # noqa: BLE001
            continue
        for obj in (data if isinstance(data, list) else [data]):
            if isinstance(obj, dict) and obj.get("@type") == "TVSeason":
                return obj
    return None


RE_SEASON_SUFFIX = re.compile(
    r"[\s　]*(?:"
    r"[<＜〈(（\[【][^<＜〈>＞〉]*シーズン[^>＞〉)）\]】]*[>＞〉)）\]】]"
    r"|(?:シーズン|Season|SEASON|season)[\s　]*[0-9０-９一二三四五六七八九十]+.*"
    r"|[0-9０-９]+(?:st|nd|rd|th)[\s　]*(?:Season|season|SEASON).*"
    r"|The Final Season.*|ファイナルシーズン.*|ファイナル・シーズン.*"
    r"|第[0-9０-９一二三四五六七八九十]+(?:期|シリーズ|シーズン|クール|部|章).*"
    r"|(?:Part|PART)\.?[\s　]*[0-9０-９]+.*"
    r"|(?<=[\s　])[0-9]+(?:st|nd|rd|th)"
    r")$"
)
RE_ROMAN_TAIL = re.compile(r"[\s　]+[ⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+$|[\s　]+(?:II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV)$")


def _series_title_guess(title):
    """シーズン名から「シーズン3」「第2期」などを外してシリーズ名を推定する。
    登録後に作品詳細のシリーズ名で正しく置き換わるので、一覧表示用の簡易版。"""
    t = RE_SEASON_SUFFIX.sub("", title or "").strip()
    t = RE_ROMAN_TAIL.sub("", t).strip()
    return t or title


def _parse_series_cassettes(html_text):
    """一覧・検索ページのカセットを、出てきた順にシリーズごとへまとめる。"""
    groups = {}
    for chunk in html_text.split('class="js-cassette"')[1:]:
        sm = RE_FM_S_SERIES.search(chunk)
        tm = RE_FM_S_TITLE.search(chunk)
        if not sm or not tm:
            continue
        series, season = sm.group(2), sm.group(3)
        dm = RE_FM_S_DATE.search(chunk)
        pm = RE_FM_S_POSTER_ANY.search(chunk)
        g = groups.setdefault(series, [])
        if any(s["season"] == season for s in g):
            continue
        g.append({"season": season, "title": _clean(tm.group(1)),
                  "date": dm.group(1) + dm.group(2) + (dm.group(3) or "00") if dm else "99999999",
                  "poster": pm.group(1) if pm else ""})
    return groups


def filmarks_series_list(media, kind, value="", start=1, pages=2):
    """ドラマ／アニメの一覧（人気・年別・ジャンル・国）をシリーズ単位で返す。"""
    base = "list-drama" if media == "drama" else "list-anime"
    if kind == "trend":
        url = f"https://filmarks.com/{base}/trend"
    elif kind == "year":
        y = int(value)
        url = f"https://filmarks.com/{base}/year/{y // 10 * 10}s/{y}"
    elif kind == "person":
        url = f"https://filmarks.com/people/{int(value)}/{SERIES_PATH[media]}"
    elif kind in ("genre", "country") and media == "drama":
        url = f"https://filmarks.com/{base}/{kind}/{int(value)}"
    else:
        raise ValueError("bad_kind")
    page_urls = [url + ("" if pg == 1 else f"?page={pg}") for pg in range(start, start + pages)]
    _prefetch(page_urls)
    out, seen, has_more = [], set(), False
    for pg, pu in zip(range(start, start + pages), page_urls):
        try:
            html_text = _fetch(pu)
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 410):
                has_more = False
                break
            raise
        groups = _parse_series_cassettes(html_text)
        if not groups:
            has_more = False
            break
        has_more = f"page={pg + 1}" in html_text
        for series, seasons in groups.items():
            if series in seen:
                continue
            seen.add(series)
            rep = min(seasons, key=lambda s: int(s["season"]))
            year = "" if rep["date"].startswith("9999") else rep["date"][:4]
            out.append({
                "id": f"{SERIES_PREFIX[media]}{series}-{rep['season']}",
                "title": _series_title_guess(rep["title"]), "year": year,
                "poster": _poster_url(rep["poster"]), "media": media,
            })
    return out, has_more


def filmarks_series_coming(media):
    """これから放送・配信が始まるドラマ／アニメ（シーズン単位）を開始日の早い順に返す。
    ドラマは年別一覧（今年・来年）、アニメは放送時期別一覧（今期から3クール分）から拾う。"""
    now = time.localtime()
    today = time.strftime("%Y%m%d", now)
    base = "list-drama" if media == "drama" else "list-anime"
    urls = []
    if media == "drama":
        for y in (now.tm_year, now.tm_year + 1):
            u = f"https://filmarks.com/{base}/year/{y // 10 * 10}s/{y}"
            urls += [u] + [f"{u}?page={pg}" for pg in range(2, 6)]
    else:
        y, m = now.tm_year, (now.tm_mon - 1) // 3 * 3 + 1
        for _ in range(3):
            u = f"https://filmarks.com/{base}/release_year/{y}/{m}"
            urls += [u, f"{u}?page=2"]
            m += 3
            if m > 12:
                y, m = y + 1, 1
    _prefetch(urls)
    best = {}
    for u in urls:
        try:
            html_text = _fetch(u)
        except Exception:  # noqa: BLE001
            continue
        for series, seasons in _parse_series_cassettes(html_text).items():
            for se in seasons:
                d = se["date"]
                if d.startswith("9999") or (d < today and not (d.endswith("00") and d[:6] > today[:6])):
                    continue
                cur = best.get(series)
                if not cur or d < cur["date"]:
                    best[series] = dict(se, date=d)
    out = []
    for series, se in sorted(best.items(), key=lambda kv: kv[1]["date"]):
        d = se["date"]
        out.append({
            "id": f"{SERIES_PREFIX[media]}{series}-{se['season']}",
            "title": _series_title_guess(se["title"]), "seasonTitle": se["title"],
            "year": d[:4], "date": f"{d[:4]}-{d[4:6]}" + ("" if d.endswith("00") else f"-{d[6:8]}"),
            "poster": _poster_url(se["poster"]), "media": media,
        })
    return out


def filmarks_series_search(query, media, limit=20, resolve=True):
    """Filmarks のドラマ／アニメ検索。シーズンをシリーズごとにまとめ、
    最初のシーズンを代表にしてシリーズ名・開始年・ポスターを返す。"""
    q = urllib.parse.quote(query, safe="")
    html_text = _fetch(f"https://filmarks.com/search/{SERIES_PATH[media]}?q={q}")
    groups = _parse_series_cassettes(html_text)
    reps = []
    for series, seasons in list(groups.items())[:limit]:
        rep = min(seasons, key=lambda s: int(s["season"]))
        reps.append((series, rep, len(seasons), "" if rep["date"].startswith("9999") else rep["date"][:4]))
    urls = [f"https://filmarks.com/{SERIES_PATH[media]}/{s}/{r['season']}" for s, r, _, _ in reps]
    if resolve:
        _prefetch(urls)
    results = []
    for (series, rep, n, year), url in zip(reps, urls):
        title = rep["title"] if resolve else _series_title_guess(rep["title"])
        try:
            if not resolve:
                raise LookupError
            ld = _filmarks_ld_season(_fetch(url)) or {}
            sr = ld.get(media + "Series") or {}
            title = (sr.get("title") or "").strip() or title
            sd = sr.get("startDate") or ""
            if re.match(r"\d{4}", sd):
                year = sd[:4]
        except Exception:  # noqa: BLE001
            pass
        results.append({
            "id": f"{SERIES_PREFIX[media]}{series}-{rep['season']}",
            "title": title, "year": year,
            "poster": _poster_url(rep["poster"]), "url": url,
            "media": media, "seasons": n,
        })
    return results


# 作品ページ内のジャンルリンク（/list/genre/<id>）からジャンルIDを拾う
RE_FM_MOVIE_GENRE = re.compile(r'/list/genre/(\d+)"')


def _fm_norm_title(t):
    """タイトル照合用の簡易正規化（空白・中黒・記号を除去して小文字化）。"""
    return re.sub(r"[\s\u3000・:：!！?？.,、。'\"’”\-–—]", "", t or "").lower()


def filmarks_movie_genres(title, year=""):
    """タイトルから Filmarks の作品を特定し、そのジャンルID一覧を返す。
    検索結果の中からタイトル完全一致（あれば公開年が近いもの）を優先する。
    見つからない・取得失敗時は空リストを返す。"""
    if not title:
        return []
    try:
        results = filmarks_search(title, limit=10)
    except Exception:
        return []
    if not results:
        return []
    nt = _fm_norm_title(title)
    exact = [r for r in results if _fm_norm_title(r.get("title")) == nt]
    cands = exact or results
    best = cands[0]
    if year:
        ymatch = [r for r in cands if str(r.get("year") or "") == str(year)]
        if ymatch:
            best = ymatch[0]
    try:
        html_text = _fetch(best["url"])
    except Exception:
        return []
    ids = []
    for gid in RE_FM_MOVIE_GENRE.findall(html_text):
        gi = int(gid)
        if gi not in ids:
            ids.append(gi)
    return ids


def batch_movie_genres(items):
    """items: [{"title":..., "year":...}]。{title: [genreId,...]} を返す。
    タイトルごとに Filmarks を検索→作品ページ取得するため、並列で処理する。"""
    items = items[:40]  # 1リクエストで捌く上限

    def work(it):
        return it.get("title", ""), filmarks_movie_genres(it.get("title", ""), it.get("year", ""))

    out = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for title, ids in ex.map(work, items):
            if title:
                out[title] = ids
    return out


# =======================================================================
# Filmarks 作品詳細（監督・出演・製作国・ジャンル・公開年）
# =======================================================================
RE_LD_JSON = re.compile(
    r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>', re.S
)


def _filmarks_ld_movie(html_text):
    """作品ページの JSON-LD から @type=Movie のオブジェクトを取り出す。"""
    for m in RE_LD_JSON.finditer(html_text):
        try:
            data = json.loads(m.group(1))
        except Exception:  # noqa: BLE001
            continue
        for obj in (data if isinstance(data, list) else [data]):
            if isinstance(obj, dict) and obj.get("@type") == "Movie":
                return obj
    return None


def _names(seq):
    out = []
    for p in seq or []:
        if isinstance(p, dict) and p.get("name"):
            out.append(p["name"].strip())
    return out


def filmarks_movie_details(movie_id):
    """Filmarks 作品ページから監督・キャスト・製作国・ジャンル・公開年を取得する。
    返り値: {directors, cast, year, country, jp, anime, genres, genreIds, rating, ratingCount}"""
    empty = {"directors": [], "cast": [], "year": "", "country": "",
             "jp": False, "anime": False, "genres": [], "genreIds": [],
             "rating": 0, "ratingCount": 0}
    sm = RE_SERIES_FID.match(str(movie_id))
    try:
        html_text = _fetch(_series_url(movie_id) if sm else f"https://filmarks.com/movies/{movie_id}")
    except Exception:  # noqa: BLE001
        return empty
    if sm:
        return _series_details(html_text, "drama" if sm.group(1) == "d" else "anime", empty)
    ld = _filmarks_ld_movie(html_text) or {}
    directors = _names(ld.get("director"))
    cast = _names(ld.get("actor"))[:8]
    countries = [c.get("name") for c in (ld.get("countries") or [])
                 if isinstance(c, dict) and c.get("name")]
    genres = ld.get("genres") or []
    if isinstance(genres, str):
        genres = [genres]
    rd = ld.get("releaseDate") or ""
    year = rd[:4] if re.match(r"\d{4}", rd) else ""
    country = countries[0] if countries else ""
    jp = "日本" in countries
    anime = any("アニメ" in g for g in genres)
    gids = []
    for gid in RE_FM_MOVIE_GENRE.findall(html_text):
        gi = int(gid)
        if gi not in gids:
            gids.append(gi)
    agg = ld.get("aggregateRating") or {}
    try:
        rating = float(agg.get("ratingValue") or 0)
    except (TypeError, ValueError):
        rating = 0
    try:
        rating_count = int(agg.get("ratingCount") or agg.get("reviewCount") or 0)
    except (TypeError, ValueError):
        rating_count = 0
    return {"directors": directors, "cast": cast, "year": year,
            "country": country, "jp": jp, "anime": anime,
            "genres": genres, "genreIds": gids,
            "rating": rating, "ratingCount": rating_count}


def _series_details(html_text, media, empty):
    ld = _filmarks_ld_season(html_text)
    if not ld:
        return empty
    countries = [c.get("name") for c in (ld.get("countries") or [])
                 if isinstance(c, dict) and c.get("name")]
    genres = ld.get("genres") or []
    if isinstance(genres, str):
        genres = [genres]
    if media == "anime" and "アニメ" not in genres:
        genres = genres + ["アニメ"]
    sd = (ld.get(media + "Series") or {}).get("startDate") or ld.get("releaseDate") or ""
    agg = ld.get("aggregateRating") or {}
    try:
        rating = float(agg.get("ratingValue") or 0)
    except (TypeError, ValueError):
        rating = 0
    try:
        rating_count = int(agg.get("ratingCount") or agg.get("reviewCount") or 0)
    except (TypeError, ValueError):
        rating_count = 0
    return {"directors": _names(ld.get("director")), "cast": _names(ld.get("actor"))[:8],
            "year": sd[:4] if re.match(r"\d{4}", sd) else "",
            "country": countries[0] if countries else "", "jp": "日本" in countries,
            "anime": media == "anime", "genres": genres, "genreIds": [],
            "rating": rating, "ratingCount": rating_count, "media": media,
            "seriesTitle": ((ld.get(media + "Series") or {}).get("title") or "").strip()}


def batch_filmarks_details(ids):
    ids = ids[:MAX_CREDITS]
    results = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for mid, det in zip(ids, ex.map(filmarks_movie_details, ids)):
            results[mid] = det
    return results


# =======================================================================
# JustWatch: 「いま観られる方法」（日本での配信/レンタル/購入/劇場）
# 公開API相当の GraphQL を、キャッシュ＆レート制限つきで代理取得する。
# 視聴状況は頻繁に変わらないため、キャッシュを効かせて礼儀正しく取得する。
# =======================================================================
JW_GQL = "https://apis.justwatch.com/graphql"
JW_QUERY = (
    "query CTL_Watch($country: Country!, $language: Language!, $first: Int!, "
    "$filter: TitleFilter) {\n"
    "  popularTitles(country: $country, first: $first, filter: $filter) {\n"
    "    edges { node {\n"
    "      objectType\n"
    "      content(country: $country, language: $language) {\n"
    "        title originalReleaseYear fullPath\n"
    "      }\n"
    "      offers(country: $country, platform: WEB) {\n"
    "        monetizationType package { clearName }\n"
    "      }\n"
    "    } } } }"
)


def _jw_norm(s):
    return re.sub(r"[\s\u3000・:：!！?？.,'\"()（）\-–—]", "", (s or "")).lower()


def justwatch_watch(title, year=""):
    """JustWatch から日本の視聴手段を取得する。
    返り値: {"offers": [{"type": flatrate|free|ads|rent|buy|cinema, "name": str}],
             "url": JustWatch作品ページURL}
    """
    key = ("https://apis.justwatch.com/graphql?q=" + urllib.parse.quote(title)
           + "&y=" + str(year))
    cached = _cache_read(key)
    if cached is not None:
        try:
            return json.loads(cached)
        except Exception:  # noqa: BLE001
            pass
    body = json.dumps({
        "operationName": "CTL_Watch",
        "variables": {"country": "JP", "language": "ja", "first": 8,
                      "filter": {"searchQuery": title}},
        "query": JW_QUERY,
    }).encode("utf-8")
    with _fetch_sem:
        _throttle("apis.justwatch.com")
        req = urllib.request.Request(
            JW_GQL, data=body,
            headers={"User-Agent": UA, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    edges = ((((data or {}).get("data") or {}).get("popularTitles") or {})
             .get("edges") or [])
    # タイトル（＋製作年）で最有力候補を選ぶ（誤マッチ防止に閾値を設ける）
    nt = _jw_norm(title)
    want_year = str(year)[:4] if year else ""
    best, best_score = None, -1
    for e in edges:
        node = e.get("node") or {}
        c = node.get("content") or {}
        nc = _jw_norm(c.get("title"))
        score = 0
        if nc and nc == nt:
            score = 100
        elif nc and (nt in nc or nc in nt):
            score = 60
        if want_year and str(c.get("originalReleaseYear") or "") == want_year:
            score += 20
        if score > best_score:
            best_score, best = score, node
    result = {"offers": [], "url": ""}
    if best and best_score >= 60:
        c = best.get("content") or {}
        fp = c.get("fullPath") or ""
        if fp:
            result["url"] = "https://www.justwatch.com" + fp
        seen, offers = set(), []
        for o in best.get("offers") or []:
            mt = (o.get("monetizationType") or "").lower()
            pk = ((o.get("package") or {}).get("clearName") or "").strip()
            if not pk or (mt, pk) in seen:
                continue
            seen.add((mt, pk))
            offers.append({"type": mt, "name": pk})
        result["offers"] = offers
    _cache_write(key, json.dumps(result, ensure_ascii=False))
    return result


# --- 映画館で上映中か（Filmarks の「上映中」一覧で判定） ----------------------
_NOW_CACHE = {"ts": 0.0, "data": None}
_NOW_TTL = 3 * 3600


def filmarks_now_index():
    """Filmarks の「上映中」一覧 (/list/now) を集約して、
    {"ids": set(str), "by_title": {正規化タイトル: id}} を返す。数時間メモ化する。"""
    now = time.time()
    if _NOW_CACHE["data"] is not None and now - _NOW_CACHE["ts"] < _NOW_TTL:
        return _NOW_CACHE["data"]
    ids, by_title = set(), {}
    for page in range(1, 9):
        url = "https://filmarks.com/list/now"
        if page > 1:
            url += f"?page={page}"
        try:
            html_text = _fetch(url)
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 410):
                break
            raise
        except Exception:  # noqa: BLE001
            break
        items = _parse_filmarks_year_list(html_text, "")
        if not items:
            break
        for it in items:
            mid = str(it["id"])
            ids.add(mid)
            by_title[_jw_norm(it["title"])] = mid
    data = {"ids": ids, "by_title": by_title}
    _NOW_CACHE["ts"], _NOW_CACHE["data"] = now, data
    return data


def theater_status(title, year="", fid=""):
    """いま映画館で上映中かを返す。
    返り値: {"showing": bool, "url": 上映館ページURL}"""
    fid = str(fid or "")
    if RE_SERIES_FID.match(fid):
        return {"showing": False, "url": ""}
    try:
        idx = filmarks_now_index()
    except Exception:  # noqa: BLE001
        return {"showing": False, "url": ""}
    hit_id = idx["by_title"].get(_jw_norm(title))
    showing = bool((fid and fid in idx["ids"]) or hit_id)
    theater_id = fid if (fid and fid in idx["ids"]) else (hit_id or fid)
    url = (f"https://filmarks.com/movies/{theater_id}/theaters"
           if theater_id else "https://filmarks.com/list/now")
    return {"showing": showing, "url": url}


# =======================================================================
# Filmarks 人物検索・フィルモグラフィ
# =======================================================================
RE_FM_PSN_NAME = re.compile(r'class="c2-person-m__name" href="/people/(\d+)">([^<]+)</a>')
RE_FM_PSN_AVATAR = re.compile(
    r'href="/people/(\d+)"><div class="c2-avatar">.*?<img alt="[^"]*" src="([^"]+)"', re.S
)


def filmarks_person_search(query, limit=12):
    """Filmarks の人物検索。返り値 各要素: {id, name, photo}"""
    q = urllib.parse.quote(query, safe="")
    html_text = _fetch(f"https://filmarks.com/search/people?q={q}")
    photos = {pid: src for pid, src in RE_FM_PSN_AVATAR.findall(html_text)}
    results = []
    seen = set()
    for pid, name in RE_FM_PSN_NAME.findall(html_text):
        if pid in seen:
            continue
        seen.add(pid)
        nm = _clean(name)
        if not nm:
            continue
        results.append({"id": pid, "name": nm,
                        "photo": _poster_url(photos.get(pid, ""))})
        if len(results) >= limit:
            break
    return results


def filmarks_person_movies(person_id, max_pages=8):
    """人物のフィルモグラフィを /people/<id>/movies から取得する。
    各作品: {id, title, year, poster, role, url}。role は Filmarks では取得できない
    ため空文字（クライアント側は role 未指定でも動作する）。"""
    items = []
    seen = set()
    for page in range(1, max_pages + 1):
        url = f"https://filmarks.com/people/{person_id}/movies"
        if page > 1:
            url += f"?page={page}"
        try:
            html_text = _fetch(url)
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 410):
                break
            break
        except Exception:  # noqa: BLE001
            break
        page_items = _parse_filmarks_year_list(html_text, "")
        new = 0
        for it in page_items:
            if it["id"] in seen:
                continue
            seen.add(it["id"])
            new += 1
            yr = it.get("date", "")[:4] if it.get("date") else ""
            items.append({"id": it["id"], "title": it["title"], "year": yr,
                          "date": it.get("date", ""),
                          "poster": it["poster"], "role": "", "url": it["url"]})
        if new == 0 or f"page={page + 1}" not in html_text:
            break
        if page in (1, 4):
            base = f"https://filmarks.com/people/{person_id}/movies?page="
            _prefetch([base + str(p) for p in range(page + 1, min(page + 4, max_pages) + 1)])
    return items


# =======================================================================
# アカウント / データ同期（標準ライブラリのみ）
#   - パスワードは PBKDF2-HMAC-SHA256 でソルト付きハッシュ化
#   - セッションは HMAC 署名付きの stateless トークン（Cookie）
#   - ユーザー情報は data/users.json、各ユーザーの Tier List は data/lists/<id>.json
# =======================================================================
DATA_DIR = os.environ.get("TIARI_DATA_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
LISTS_DIR = os.path.join(DATA_DIR, "lists")
CHALLENGES_DIR = os.path.join(DATA_DIR, "challenges")
USERS_PATH = os.path.join(DATA_DIR, "users.json")
SECRET_PATH = os.path.join(DATA_DIR, "secret.key")
PBKDF2_ITER = 200_000
SESSION_TTL = 60 * 60 * 24 * 30  # 30日
MAX_LIST_BYTES = 30 * 1024 * 1024  # 1ユーザーの保存上限（アップロード画像込み）
# ユーザー名は「半角英数記号の2〜32文字」または「メールアドレス」を許可する
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{2,32}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_data_lock = threading.Lock()


def _valid_username(name):
    if not name:
        return False
    if USERNAME_RE.match(name):
        return True
    return len(name) <= 254 and bool(EMAIL_RE.match(name))


def _ensure_data_dirs():
    os.makedirs(LISTS_DIR, exist_ok=True)
    os.makedirs(CHALLENGES_DIR, exist_ok=True)


# -----------------------------------------------------------------------
# クラウド運用時の保存先（GitHub の非公開リポジトリ）
#   GITHUB_TOKEN と DATA_REPO（例: user/tierlist-data）を設定すると、
#   users.json / lists/*.json を GitHub にも保存し、起動時に復元する。
#   無料サーバーはディスクが再起動で消えるため、その対策。
# -----------------------------------------------------------------------
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
DATA_REPO = os.environ.get("DATA_REPO", "")
REMOTE_ON = bool(GITHUB_TOKEN and DATA_REPO)
ALLOW_REGISTER = os.environ.get("ALLOW_REGISTER", "1") != "0"
# 参加者数・評価数などの実数は、ここに書いたユーザー名（カンマ区切り）にだけ返す
ADMIN_USERS = {x.strip().lower() for x in os.environ.get("ADMIN_USERS", "").split(",") if x.strip()}
_remote_sha = {}
_remote_pending = set()
_remote_cv = threading.Condition()


def _gh(method, relpath, body=None, raw=False):
    url = f"{os.environ.get('GITHUB_API', 'https://api.github.com')}/repos/{DATA_REPO}/contents/{urllib.parse.quote(relpath)}"
    headers = {"Authorization": f"Bearer {GITHUB_TOKEN}",
               "Accept": "application/vnd.github.raw" if raw else "application/vnd.github+json",
               "User-Agent": "cinema-tier-list"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            out = resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    return out if raw else json.loads(out)


def _remote_restore():
    """起動時に GitHub から users.json と lists/*.json を取り込む。"""
    _ensure_data_dirs()
    targets = ["users.json"]
    for d in ("lists", "challenges"):
        listing = _gh("GET", d) or []
        targets += [f"{d}/{x['name']}" for x in listing if x.get("name", "").endswith(".json")]
    for rel in targets:
        meta = _gh("GET", rel)
        if not meta:
            continue
        _remote_sha[rel] = meta.get("sha")
        raw = _gh("GET", rel, raw=True)
        if raw is not None:
            with open(os.path.join(DATA_DIR, rel), "wb") as f:
                f.write(raw)
    print(f"  GitHub（{DATA_REPO}）から {len(_remote_sha)} 件のデータを復元しました")


def _remote_queue(path):
    if not REMOTE_ON:
        return
    rel = os.path.relpath(path, DATA_DIR).replace(os.sep, "/")
    with _remote_cv:
        _remote_pending.add(rel)
        _remote_cv.notify()


def _remote_upload(rel):
    with open(os.path.join(DATA_DIR, rel), "rb") as f:
        content = base64.b64encode(f.read()).decode()
    body = {"message": f"update {rel}", "content": content}
    if _remote_sha.get(rel):
        body["sha"] = _remote_sha[rel]
    try:
        res = _gh("PUT", rel, body)
    except urllib.error.HTTPError as e:
        if e.code not in (409, 422):
            raise
        meta = _gh("GET", rel)
        body["sha"] = meta.get("sha") if meta else None
        res = _gh("PUT", rel, body)
    _remote_sha[rel] = res["content"]["sha"]


def _remote_worker():
    while True:
        with _remote_cv:
            while not _remote_pending:
                _remote_cv.wait()
        time.sleep(5)  # 連続保存をまとめる
        with _remote_cv:
            batch = list(_remote_pending)
            _remote_pending.clear()
        for rel in batch:
            try:
                _remote_upload(rel)
            except Exception as exc:  # noqa: BLE001
                print(f"GitHub への保存に失敗: {rel}: {exc}", file=sys.stderr)
                with _remote_cv:
                    _remote_pending.add(rel)
                time.sleep(10)


def _get_secret():
    env = os.environ.get("SECRET_KEY")
    if env:
        return env.encode()
    _ensure_data_dirs()
    if not os.path.exists(SECRET_PATH):
        with open(SECRET_PATH, "w", encoding="utf-8") as f:
            f.write(secrets.token_hex(32))
        try:
            os.chmod(SECRET_PATH, 0o600)
        except Exception:  # noqa: BLE001
            pass
    with open(SECRET_PATH, encoding="utf-8") as f:
        return f.read().strip().encode()


SECRET = _get_secret()


def _load_users():
    try:
        with open(USERS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def _save_users(users):
    _ensure_data_dirs()
    tmp = USERS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(users, f, ensure_ascii=False)
    os.replace(tmp, USERS_PATH)
    _remote_queue(USERS_PATH)


def _hash_pw(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                             bytes.fromhex(salt), PBKDF2_ITER)
    return salt, dk.hex()


def _verify_pw(password, salt, expected):
    try:
        _, h = _hash_pw(password, salt)
    except Exception:  # noqa: BLE001
        return False
    return hmac.compare_digest(h, expected)


RC_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_reset_tries = {}  # username -> [時刻...]（復旧コードの総当たり対策）


def _new_recovery_code():
    raw = "".join(secrets.choice(RC_ALPHABET) for _ in range(16))
    return "-".join(raw[i:i + 4] for i in range(0, 16, 4))


def _norm_recovery_code(code):
    return re.sub(r"[^A-Z0-9]", "", str(code or "").upper())


def _set_recovery(u):
    """新しい復旧コードを発行して利用者に保存する（ハッシュのみ保存）。平文のコードを返す。"""
    code = _new_recovery_code()
    salt, h = _hash_pw(_norm_recovery_code(code))
    u["rc_salt"], u["rc_hash"], u["rc_at"] = salt, h, int(time.time())
    return code


def _bump_password(u, password):
    salt, h = _hash_pw(password)
    u["salt"], u["hash"] = salt, h
    u["pwv"] = int(u.get("pwv") or 0) + 1
    _pwv_cache[u["id"]] = u["pwv"]


def _b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# パスワードを変えたら、それより前に発行したログインを無効にするための版数（uid -> 版）
_pwv_cache = {}


def _pw_version(uid):
    if uid not in _pwv_cache:
        for u in _load_users().values():
            _pwv_cache[u.get("id")] = int(u.get("pwv") or 0)
    return _pwv_cache.get(uid, 0)


def _make_token(uid):
    payload = {"uid": uid, "exp": int(time.time()) + SESSION_TTL, "pv": _pw_version(uid)}
    body = _b64(json.dumps(payload).encode("utf-8"))
    sig = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()
    return body + "." + sig


def _verify_token(token):
    try:
        body, sig = token.split(".", 1)
        expected = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(_unb64(body))
        if int(payload.get("exp", 0)) < time.time():
            return None
        uid = payload.get("uid")
        if int(payload.get("pv") or 0) != _pw_version(uid):
            return None
        return uid
    except Exception:  # noqa: BLE001
        return None


COOKIE_SECURE = "; Secure" if os.environ.get("RENDER") or REMOTE_ON else ""


def _set_cookie(token):
    return (f"session={token}; Path=/; HttpOnly; SameSite=Lax; "
            f"Max-Age={SESSION_TTL}{COOKIE_SECURE}")


def _clear_cookie():
    return "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"


def _list_path(uid):
    return os.path.join(LISTS_DIR, uid + ".json")


def _load_list(uid):
    try:
        with open(_list_path(uid), encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def _save_list(uid, obj):
    _ensure_data_dirs()
    tmp = _list_path(uid) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, _list_path(uid))
    _remote_queue(_list_path(uid))


# -----------------------------------------------------------------------
# みんなのティア（全ユーザーの平均）と、友だちとの比較
#   ティアの段数は人によって違うため、各作品を 0〜1 の点（一番上=1、一番下=0）に
#   そろえてから平均・比較する。少人数で個人の評価が特定されないよう、
#   自分以外に COMMUNITY_MIN 人以上が評価した作品だけを返す。
# -----------------------------------------------------------------------
COMMUNITY_MIN = int(os.environ.get("COMMUNITY_MIN", "3"))
_KEY_STRIP = re.compile(r"[\s・:：\-－—―~〜!！?？'\"“”‘’「」『』()（）\[\]【】.,、。]")
_ratings_cache = {}   # uid -> {key: score}
_meta_cache = {}      # key -> {title, poster, year, filmarksId}
_ratings_loaded = False


def _movie_key(m):
    fid = str(m.get("filmarksId") or "").strip()
    if fid:
        return "f:" + (fid.split("-")[0] if RE_SERIES_FID.match(fid) else fid)
    title = _KEY_STRIP.sub("", unicodedata.normalize("NFKC", m.get("title") or "").lower())
    if not title:
        return None
    return "t:" + title + "|" + str(m.get("year") or "").strip()


def _movie_meta(m):
    poster = m.get("poster") or ""
    if poster.startswith("data:"):
        poster = ""
    return {"title": m.get("title") or "", "poster": poster,
            "year": str(m.get("year") or ""), "filmarksId": str(m.get("filmarksId") or "")}


def _ratings_from_list(obj):
    tiers = (obj or {}).get("tiers") or []
    n = len(tiers)
    out = {}
    for i, t in enumerate(tiers):
        score = 1.0 if n <= 1 else (n - 1 - i) / (n - 1)
        for m in t.get("items") or []:
            if not isinstance(m, dict):
                continue
            k = _movie_key(m)
            if not k or k in out:
                continue
            out[k] = round(score, 4)
            if k not in _meta_cache:
                _meta_cache[k] = _movie_meta(m)
    return out


# デモ用の仮ユーザー（users.json には保存しない。DEMO_SOCIAL=0 で無効）
DEMO_SOCIAL = os.environ.get("DEMO_SOCIAL", "1") != "0"
DEMO_NAMES = ["あおい", "シネマ太郎", "ポップコーン", "ゆうき", "夜更かし映画部", "みなと", "はるか", "レイトショー",
              "こはる", "けんじ", "映画好きOL", "そら", "たくみ", "ミニシアター通い", "りん", "ゴジラ党",
              "さくら", "ジブリっ子", "だいすけ", "名画座の常連", "めぐみ", "アクション命", "なつき", "旧作ハンター"]
DEMO_FRIENDS = 4
_demo_users_cache = None


def _demo_users():
    global _demo_users_cache
    if _demo_users_cache is not None or not DEMO_SOCIAL:
        return _demo_users_cache or []
    import random
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo_movies.json"), encoding="utf-8") as f:
            movies = json.load(f)
    except (OSError, ValueError):
        movies = []
    rng = random.Random(20261027)
    base = {m["filmarksId"]: min(0.95, max(0.2, rng.gauss(0.62, 0.17))) for m in movies}
    genres = sorted({g for m in movies for g in m.get("genres") or []})
    users = []
    for i, name in enumerate(DEMO_NAMES):
        likes = set(rng.sample(genres, 3))
        dislikes = set(rng.sample([g for g in genres if g not in likes], 2))
        era = rng.uniform(-0.15, 0.15)
        picked = rng.sample(movies, rng.randint(40, min(95, len(movies)))) if movies else []
        ratings = {}
        for m in picked:
            gs = set(m.get("genres") or [])
            s = base[m["filmarksId"]] + rng.gauss(0, 0.15)
            s += 0.22 * bool(gs & likes) - 0.22 * bool(gs & dislikes)
            s += era if (m.get("year") or "9999") < "1990" else -era
            ratings[_movie_key(m)] = round(min(4, max(0, round(s * 4))) / 4, 4)
            _meta_cache.setdefault(_movie_key(m), _movie_meta(m))
        users.append({"id": "demo:%02d" % i, "display": name, "ratings": ratings,
                      "share": "demo-%02d" % i if i < DEMO_FRIENDS else None})
    _demo_users_cache = users
    return users


def _ensure_ratings():
    """呼び出し側で _data_lock を保持していること。"""
    global _ratings_loaded
    if _ratings_loaded:
        return
    for u in _load_users().values():
        _ratings_cache[u["id"]] = _ratings_from_list(_load_list(u["id"]))
    for d in _demo_users():
        _ratings_cache[d["id"]] = d["ratings"]
    _ratings_loaded = True


def _community_agg(exclude_uid=None, keys=None):
    users = _load_users()
    off = {u["id"] for u in users.values() if u.get("community") is False}
    agg = {}
    want = set(keys) if keys is not None else None
    for uid, ratings in _ratings_cache.items():
        if uid == exclude_uid or uid in off:
            continue
        for k, s in ratings.items():
            if want is not None and k not in want:
                continue
            a = agg.setdefault(k, {"sum": 0.0, "count": 0, "hist": [0, 0, 0, 0, 0]})
            a["sum"] += s
            a["count"] += 1
            a["hist"][4 - int(round(s * 4))] += 1
    out = {}
    for k, a in agg.items():
        if a["count"] < COMMUNITY_MIN:
            continue
        out[k] = {"avg": round(a["sum"] / a["count"], 4), "count": a["count"], "hist": a["hist"]}
    return out


def _demo_agg(key):
    """デモ表示用：まだ評価が集まっていない作品にも、作品ごとに決まった仮の「みんなのティア」を作る。"""
    import random
    rng = random.Random(hashlib.sha256(("demo-agg:" + key).encode("utf-8")).hexdigest())
    base = min(0.9, max(0.25, rng.gauss(0.6, 0.15)))
    n = rng.randint(6, 28)
    hist = [0, 0, 0, 0, 0]
    total = 0.0
    for _ in range(n):
        sc = min(4, max(0, round((base + rng.gauss(0, 0.2)) * 4))) / 4
        hist[4 - int(round(sc * 4))] += 1
        total += sc
    return {"avg": round(total / n, 4), "count": n, "hist": hist, "demo": True}


def _hide_counts(agg):
    return {k: {kk: vv for kk, vv in v.items() if kk != "count"} for k, v in agg.items()}


def _user_by_share(token):
    if not token:
        return None
    for d in _demo_users():
        if d["share"] and d["share"] == token:
            return d
    for u in _load_users().values():
        if u.get("share") and hmac.compare_digest(u["share"], token):
            return u
    return None


def _display_name(u):
    name = (u.get("display") or "").strip()
    if name:
        return name
    if EMAIL_RE.match(u.get("username") or ""):
        return "名無しさん"
    return u.get("username") or "名無しさん"


def _similar_people(mine, uid, include_real, limit=12):
    """好みが似ている人：共通の作品が5本以上ある相手との一致度を出し、高い順に並べる。"""
    cands = []
    if include_real:
        for u in _load_users().values():
            if u.get("id") == uid or u.get("community") is False or not _privacy(u)["simPublic"]:
                continue
            cands.append((_display_name(u), _ratings_cache.get(u["id"]) or {}, u.get("share") or "", False))
    if DEMO_SOCIAL and len(cands) < 3:
        for d in _demo_users():
            cands.append((d["display"], d["ratings"], d["share"] or "", True))
    out = []
    for name, r, share, demo in cands:
        common = [k for k in mine if k in r]
        if len(common) < 5:
            continue
        agreement = 1 - sum(abs(mine[k] - r[k]) for k in common) / len(common)
        match = max(0, min(100, round((agreement - 0.5) / 0.5 * 100)))
        both = sorted((k for k in common if mine[k] >= 0.75 and r[k] >= 0.75), key=lambda k: -(mine[k] + r[k]))
        recs = sorted((k for k in r if k not in mine and r[k] >= 0.75), key=lambda k: -r[k])
        meta = lambda k: dict(_meta_cache.get(k) or {}, key=k)
        out.append({"name": name, "match": match, "common": len(common), "share": share, "demo": demo,
                     "both": [meta(k) for k in both[:4]], "recs": [meta(k) for k in recs[:4]]})
    out.sort(key=lambda x: (-x["match"], -x["common"]))
    return out[:limit]


def _compare(friend_ratings, mine):
    common = [k for k in mine if k in friend_ratings]
    diffs = [abs(mine[k] - friend_ratings[k]) for k in common]
    match = None
    if len(common) >= 5:
        agreement = 1 - sum(diffs) / len(diffs)
        match = max(0, min(100, round((agreement - 0.5) / 0.5 * 100)))

    def item(k):
        d = dict(_meta_cache.get(k) or {})
        d.update({"key": k, "friend": friend_ratings.get(k), "mine": mine.get(k)})
        return d

    both = sorted((k for k in common if mine[k] >= 0.75 and friend_ratings[k] >= 0.75),
                  key=lambda k: -(mine[k] + friend_ratings[k]))
    split = sorted((k for k in common if abs(mine[k] - friend_ratings[k]) >= 0.5),
                   key=lambda k: -abs(mine[k] - friend_ratings[k]))
    recs = sorted((k for k in friend_ratings if k not in mine and friend_ratings[k] >= 0.75),
                  key=lambda k: -friend_ratings[k])
    return {"match": match, "common": len(common), "friendTotal": len(friend_ratings),
            "both": [item(k) for k in both[:24]], "split": [item(k) for k in split[:24]],
            "recs": [item(k) for k in recs[:24]]}


PRIVACY_KEYS = ("cmpBoth", "cmpSplit", "cmpRecs", "tlWhere", "tlWith", "tlNote", "cmtPublic", "kinPublic", "simPublic")
# これまで本人だけのメモ・印として付けてきたため、コメントの公開と「同じ偏愛・思い出の人」「似ている人」への表示は本人が選ぶまでオフ
PRIVACY_OFF_BY_DEFAULT = {"cmtPublic", "kinPublic", "simPublic"}


def _privacy(u):
    p = u.get("privacy") if isinstance(u.get("privacy"), dict) else {}
    return {k: (p.get(k) is True) if k in PRIVACY_OFF_BY_DEFAULT else (p.get(k) is not False) for k in PRIVACY_KEYS}


DEMO_COMMENTS = {
    "high": ["何度観ても胸が熱くなる。文句なしの一本です。", "ラストで鳥肌が立った。映画館で観られて本当によかった。",
             "音楽と映像の重なり方が完璧。人生ベスト級。", "登場人物みんなが愛おしい。また観返したい。",
             "公開当時に観て衝撃を受けました。今観ても色あせない。"],
    "mid": ["前半は少し長く感じたけれど、後半の盛り上がりは見事。", "好みは分かれそうだけど、映像は一見の価値あり。",
            "期待しすぎたかも。でも主演の演技はとても良かった。", "雰囲気は好き。もう一度観たら印象が変わりそう。"],
    "low": ["自分には合わなかったけれど、熱狂的なファンがいるのはわかる。", "話題作だったので観たものの、展開が読めてしまった。",
            "映像はきれいだが、物語に入り込めなかった。"],
}


def _demo_comments(key, n_max=5):
    import random
    rng = random.Random(hashlib.sha256(("demo-cmt:" + key).encode("utf-8")).hexdigest())
    names = rng.sample(DEMO_NAMES, min(len(DEMO_NAMES), rng.randint(3, n_max)))
    out = []
    for name in names:
        sc = rng.choice([1, 1, 0.75, 0.75, 0.75, 0.5, 0.25])
        pool = DEMO_COMMENTS["high" if sc >= 0.75 else "mid" if sc >= 0.5 else "low"]
        out.append({"name": name, "score": sc, "text": rng.choice(pool), "demo": True})
    return out


WHERE_KEYS = ("theater", "stream", "tv", "disc", "other")
WITH_KEYS = ("alone", "friend", "partner", "family", "kids", "other")


def _movie_extras(key, exclude_uid=None):
    """この作品を登録した人のうち、偏愛・思い出を書いた人の割合と、観た場所・一緒に観た人の内訳（匿名の集計）。"""
    n = fav = mem = 0
    where, with_ = {}, {}
    for u in _load_users().values():
        if u.get("id") == exclude_uid or u.get("community") is False:
            continue
        obj = _load_list(u["id"]) or {}
        items = [m for t in (obj.get("tiers") or []) for m in (t.get("items") or [])] + list(obj.get("pool") or [])
        m = next((x for x in items if isinstance(x, dict) and _movie_key(x) == key), None)
        if not m:
            continue
        n += 1
        if m.get("fav"):
            fav += 1
        me = m.get("memory") if isinstance(m.get("memory"), dict) else {}
        if any(me.get(k) for k in ("when", "where", "with", "note", "whereType", "withType")):
            mem += 1
        wt = me.get("whereType")
        if wt in WHERE_KEYS:
            where[wt] = where.get(wt, 0) + 1
        for w in (me.get("withType") or []) if isinstance(me.get("withType"), list) else []:
            if w in WITH_KEYS:
                with_[w] = with_.get(w, 0) + 1
    if n < COMMUNITY_MIN:
        return None
    return {"n": n, "fav": fav, "mem": mem, "where": where, "with": with_}


def _find_in_list(obj, key):
    obj = obj or {}
    items = [m for t in (obj.get("tiers") or []) for m in (t.get("items") or [])] + list(obj.get("pool") or [])
    return next((x for x in items if isinstance(x, dict) and _movie_key(x) == key), None)


def _has_mem(m):
    me = m.get("memory") if isinstance(m.get("memory"), dict) else {}
    return any(me.get(k) for k in ("when", "where", "with", "note", "whereType", "withType"))


def _movie_kin(key, uid):
    """同じ作品を偏愛・思い出登録している人（お互いに「表示する」を選んだ人どうしだけ）。"""
    users = _load_users()
    me_u = next((u for u in users.values() if u.get("id") == uid), None) if uid else None
    if not me_u:
        return {"status": "need_login", "people": []}
    if not _privacy(me_u)["kinPublic"]:
        return {"status": "need_optin", "people": []}
    mine = _find_in_list(_load_list(uid), key)
    if not mine or not (mine.get("fav") or _has_mem(mine)):
        return {"status": "need_mine", "people": []}
    people = []
    for u in users.values():
        if u.get("id") == uid or u.get("community") is False or not _privacy(u)["kinPublic"]:
            continue
        m = _find_in_list(_load_list(u["id"]), key)
        if not m or not (m.get("fav") or _has_mem(m)):
            continue
        people.append({"name": _display_name(u), "fav": bool(m.get("fav")), "mem": _has_mem(m),
                       "share": u.get("share") or ""})
        if len(people) >= 50:
            break
    return {"status": "ok", "people": people}


def _demo_kin(key):
    import random
    rng = random.Random(hashlib.sha256(("demo-kin:" + key).encode("utf-8")).hexdigest())
    idx = rng.sample(range(len(DEMO_NAMES)), rng.randint(3, 6))
    out = []
    for i in idx:
        fav = rng.random() < 0.6
        out.append({"name": DEMO_NAMES[i], "fav": fav, "mem": (not fav) or rng.random() < 0.5,
                    "share": "demo-%02d" % i if i < DEMO_FRIENDS else "", "demo": True})
    return out


def _demo_extras(key):
    import random
    rng = random.Random(hashlib.sha256(("demo-extra:" + key).encode("utf-8")).hexdigest())
    n = rng.randint(12, 40)
    fav = round(n * rng.uniform(0.05, 0.3))
    mem = round(n * rng.uniform(0.15, 0.45))
    weights_w = [rng.uniform(1, 6), rng.uniform(1, 4), rng.uniform(0.3, 2), rng.uniform(0.2, 1.5), rng.uniform(0, 0.5)]
    weights_c = [rng.uniform(1, 4), rng.uniform(0.5, 3), rng.uniform(0.3, 2), rng.uniform(0.5, 3), rng.uniform(0, 1), rng.uniform(0, 0.4)]
    mem = max(mem, 4)
    where, with_ = {}, {}
    for _ in range(mem):
        w = rng.choices(WHERE_KEYS, weights=weights_w)[0]
        where[w] = where.get(w, 0) + 1
        for c in set(rng.choices(WITH_KEYS, weights=weights_c, k=rng.choice([1, 1, 1, 2]))):
            with_[c] = with_.get(c, 0) + 1
    return {"n": n, "fav": fav, "mem": mem, "where": where, "with": with_, "demo": True}


def _extras_public(x, admin):
    """管理者以外には人数を返さず、割合だけにする。"""
    n = x["n"] or 1
    mem = x["mem"] or 1
    out = {"favRate": round(x["fav"] / n, 3), "memRate": round(x["mem"] / n, 3),
           "where": {k: round(v / mem, 3) for k, v in x["where"].items()},
           "with": {k: round(v / mem, 3) for k, v in x["with"].items()},
           "demo": bool(x.get("demo"))}
    if admin:
        out.update({"n": x["n"], "fav": x["fav"], "mem": x["mem"]})
    return out


DEMO_TAGS = ["泣ける", "人生ベスト", "何度も観たい", "映像美", "音楽が最高", "伏線回収", "元気が出る",
             "考察したくなる", "デート向け", "家族で観たい", "雨の日に観たい", "劇場で観たい", "心に残るセリフ", "ラストが衝撃"]


def _community_tags(key, exclude_uid=None):
    """みんながよく使うタグと、この作品によく付けられているタグ（3人以上が使っているものだけ・匿名）。"""
    users_by_tag, movie_tag = {}, {}
    for u in _load_users().values():
        if u.get("id") == exclude_uid or u.get("community") is False:
            continue
        obj = _load_list(u["id"]) or {}
        items = [m for t in (obj.get("tiers") or []) for m in (t.get("items") or [])] + list(obj.get("pool") or [])
        seen = set()
        for m in items:
            if not isinstance(m, dict):
                continue
            for t in (m.get("userThemes") or []):
                t = _s(t, 30).strip()
                if not t or t.startswith("📣"):
                    continue
                if t not in seen:
                    seen.add(t)
                    users_by_tag[t] = users_by_tag.get(t, 0) + 1
                if key and _movie_key(m) == key:
                    movie_tag[t] = movie_tag.get(t, 0) + 1
    popular = sorted((t for t, n in users_by_tag.items() if n >= COMMUNITY_MIN), key=lambda t: -users_by_tag[t])[:30]
    for_movie = sorted((t for t, n in movie_tag.items() if n >= COMMUNITY_MIN), key=lambda t: -movie_tag[t])[:12]
    demo = False
    if DEMO_SOCIAL and len(popular) < 8:
        import random
        rng = random.Random(hashlib.sha256(("demo-tags:" + (key or "")).encode("utf-8")).hexdigest())
        popular += [t for t in DEMO_TAGS if t not in popular]
        if not for_movie:
            for_movie = rng.sample(DEMO_TAGS, 4)
        demo = True
    return {"popular": popular[:30], "forMovie": for_movie, "demo": demo}


def _movie_comments(key, exclude_uid=None, limit=30):
    """コメントの公開を選んだ利用者の、この作品へのコメント（評価つき）。"""
    out = []
    for u in _load_users().values():
        if u.get("id") == exclude_uid or u.get("community") is False or not _privacy(u)["cmtPublic"]:
            continue
        obj = _load_list(u["id"]) or {}
        n = len(obj.get("tiers") or [])
        found = None
        for i, t in enumerate(obj.get("tiers") or []):
            for m in (t.get("items") or []):
                if isinstance(m, dict) and _movie_key(m) == key:
                    found = (m, 1.0 if n <= 1 else (n - 1 - i) / (n - 1))
                    break
            if found:
                break
        if not found:
            continue
        text = _s(found[0].get("comment"), 600).strip()
        if text:
            out.append({"name": _display_name(u), "score": round(found[1], 4), "text": text})
        if len(out) >= limit:
            break
    return out


def _timeline_settings(u):
    return {"public": bool(u.get("timelinePublic")), "showAge": bool(u.get("timelineAge")),
            "token": u.get("timelineToken") or ""}


def _user_by_timeline(token):
    if not token:
        return None
    for u in _load_users().values():
        t = u.get("timelineToken")
        if t and u.get("timelinePublic") and hmac.compare_digest(t, token):
            return u
    return None


def _public_timeline(u, obj):
    obj = obj if isinstance(obj, dict) else {}
    items = []
    pv = _privacy(u)
    fields = ["when"] + [k for k, flag in (("where", "tlWhere"), ("with", "tlWith"), ("note", "tlNote")) if pv[flag]]

    def add(m, tier):
        if not isinstance(m, dict):
            return
        mem = m.get("memory")
        if not isinstance(mem, dict):
            return
        raw = mem
        mem = {k: _s(raw.get(k), 600 if k == "note" else 80) for k in fields}
        if "where" in fields and raw.get("whereType") in ("theater", "stream", "tv", "disc", "other"):
            mem["whereType"] = raw["whereType"]
        if "with" in fields and isinstance(raw.get("withType"), list):
            mem["withType"] = [x for x in raw["withType"][:6]
                               if x in ("alone", "friend", "partner", "family", "kids", "other")]
        mem = {k: v for k, v in mem.items() if v}
        if not mem:
            return
        poster = _s(m.get("poster"), 600)
        if not poster.startswith(("http://", "https://", "/api/img?u=")):
            poster = ""
        items.append({"title": _s(m.get("title"), 120), "year": _s(str(m.get("year") or ""), 8),
                      "poster": poster, "fav": bool(m.get("fav")), "memory": mem,
                      "tier": tier})

    for t in obj.get("tiers") or []:
        if not isinstance(t, dict):
            continue
        tier = {"label": _s(t.get("label"), 16), "color": _s(t.get("color"), 16)}
        for m in t.get("items") or []:
            add(m, tier)
    for m in obj.get("pool") or []:
        add(m, None)
    res = {"name": _display_name(u), "items": items}
    if u.get("timelineAge"):
        try:
            res["birthYear"] = int(obj.get("birthYear") or 0) or None
        except (TypeError, ValueError):
            pass
    return res


def _clean_ratings(raw):
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in list(raw.items())[:20000]:
        if isinstance(k, str) and len(k) < 300 and isinstance(v, (int, float)) and 0 <= v <= 1:
            out[k] = float(v)
    return out


# -----------------------------------------------------------------------
# お題（テーマを共有して、同じ作品セットでティアリストを作ってもらう）
#   data/challenges/<id>.json に作品セットと参加者ごとの評価（0〜1）を保存する。
# -----------------------------------------------------------------------
CHALLENGE_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{6,20}$")
PID_RE = re.compile(r"^[A-Za-z0-9_\-]{8,40}$")
CHALLENGE_MAX_MOVIES = 150
CHALLENGE_MAX_ENTRIES = 1000


def _challenge_path(cid):
    return os.path.join(CHALLENGES_DIR, cid + ".json")


DEMO_CHALLENGES = [
    ("ghibli", "ジブリで一番好きなのは？", 17, "ナウシカからトトロ、最新作まで。あなたの一番を決めてください。",
     ["風の谷のナウシカ", "天空の城ラピュタ", "となりのトトロ", "魔女の宅急便", "もののけ姫", "千と千尋の神隠し",
      "ハウルの動く城", "君たちはどう生きるか"]),
    ("scifi", "人生ベストSF", 1, "宇宙・タイムトラベル・AI。SFの名作をティア分けしよう。",
     ["2001年宇宙の旅", "スター・ウォーズ", "エイリアン", "ブレードランナー", "E.T.", "バック・トゥ・ザ・フューチャー",
      "ジュラシック・パーク", "マトリックス", "アバター", "インセプション", "ゼロ・グラビティ", "インターステラー",
      "TENET テネット", "DUNE/デューン 砂の惑星"]),
    ("hogaku", "2010年代以降の邦画ベスト", 15, "",
     ["告白", "桐島、部活やめるってよ", "湯を沸かすほどの熱い愛", "シン・ゴジラ", "怒り", "万引き家族", "カメラを止めるな！",
      "ドライブ・マイ・カー", "ゴジラ-1.0", "怪物", "PERFECT DAYS", "君の名は。", "この世界の片隅に", "すずめの戸締まり"]),
    ("namida", "泣ける映画ティア", 10, "ハンカチ必須の作品を集めました。",
     ["ショーシャンクの空に", "グリーンマイル", "ライフ・イズ・ビューティフル", "スタンド・バイ・ミー", "フォレスト・ガンプ",
      "リメンバー・ミー", "カールじいさんの空飛ぶ家", "おくりびと", "コーダ あいのうた", "グラン・トリノ",
      "ミリオンダラー・ベイビー", "セッション"]),
]
_demo_challenges_cache = None


def _demo_challenges():
    """デモのお題はメモリ上だけで持つ（参加・送信もディスクには保存しない）。"""
    global _demo_challenges_cache
    if _demo_challenges_cache is not None or not DEMO_SOCIAL:
        return _demo_challenges_cache or {}
    users = _demo_users()
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo_movies.json"), encoding="utf-8") as f:
            pool = json.load(f)
    except (OSError, ValueError):
        pool = []
    out = {}
    for slug, title, owner_i, note, titles in DEMO_CHALLENGES:
        picked = [next((m for m in pool if m["title"].startswith(t)), None) for t in titles]
        movies = _clean_challenge_movies([m for m in picked if m])
        if len(movies) < 2:
            continue
        keys = {m["key"] for m in movies}
        entries = {}
        for i, u in enumerate(users):
            r = {k: v for k, v in u["ratings"].items() if k in keys}
            if len(r) >= 2:
                entries["demo-pid-%02d" % i] = {"name": u["display"], "ratings": r, "at": 1793000000000 + i * 3600000}
        cid = "demo-" + slug
        out[cid] = {"id": cid, "title": title, "note": note, "creator": DEMO_NAMES[owner_i],
                    "ownerPid": "demo-pid-%02d" % owner_i, "createdAt": 1792900000000,
                    "movies": movies, "entries": entries}
    _demo_challenges_cache = out
    return out


def _load_challenge(cid):
    if not CHALLENGE_ID_RE.match(cid or ""):
        return None
    if cid in _demo_challenges():
        return _demo_challenges()[cid]
    try:
        with open(_challenge_path(cid), encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def _save_challenge(ch):
    if ch["id"] in _demo_challenges():
        return
    _ensure_data_dirs()
    path = _challenge_path(ch["id"])
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(ch, f, ensure_ascii=False)
    os.replace(path + ".tmp", path)
    _remote_queue(path)


def _s(v, n):
    return v.strip()[:n] if isinstance(v, str) else ""


def _clean_challenge_movies(raw):
    out, seen = [], set()
    for m in (raw if isinstance(raw, list) else [])[:CHALLENGE_MAX_MOVIES]:
        if not isinstance(m, dict):
            continue
        title = _s(m.get("title"), 200)
        if not title:
            continue
        mv = {"title": title, "year": _s(str(m.get("year") or ""), 10),
              "poster": _s(m.get("poster"), 600), "filmarksId": _s(str(m.get("filmarksId") or ""), 40)}
        if not mv["poster"].startswith(("http://", "https://", "/api/img?u=")):
            mv["poster"] = ""
        k = _movie_key(mv)
        if not k or k in seen:
            continue
        seen.add(k)
        mv["key"] = k
        out.append(mv)
    return out


def _challenge_view(ch, pid=None, admin=False):
    keys = [m["key"] for m in ch["movies"]]
    entries = ch.get("entries") or {}
    agg = {}
    for e in entries.values():
        for k, v in (e.get("ratings") or {}).items():
            a = agg.setdefault(k, {"sum": 0.0, "count": 0, "hist": [0, 0, 0, 0, 0]})
            a["sum"] += v
            a["count"] += 1
            a["hist"][4 - int(round(v * 4))] += 1
    stats = {k: {"avg": round(a["sum"] / a["count"], 4), "count": a["count"], "hist": a["hist"]}
             for k, a in agg.items() if k in keys}
    owner = entries.get(ch.get("ownerPid") or "") or {}
    mine = entries.get(pid or "") if pid else None
    match = None
    if mine and owner and pid != ch.get("ownerPid"):
        common = [k for k in mine.get("ratings", {}) if k in owner.get("ratings", {})]
        if len(common) >= 3:
            diff = sum(abs(mine["ratings"][k] - owner["ratings"][k]) for k in common) / len(common)
            match = max(0, min(100, round((1 - diff - 0.5) / 0.5 * 100)))
    recent = sorted(entries.items(), key=lambda kv: -kv[1].get("at", 0))
    view = {"id": ch["id"], "title": ch["title"], "note": ch.get("note", ""), "movies": ch["movies"],
            "creator": ch.get("creator") or "名無しさん", "createdAt": ch.get("createdAt"),
            "ownerRatings": owner.get("ratings") or {}, "stats": stats,
            "participants": len(entries), "names": [e.get("name") or "名無しさん" for _, e in recent[:30]],
            "isOwner": bool(pid) and pid == ch.get("ownerPid"),
            "mine": (mine or {}).get("ratings"), "match": match}
    if not admin:
        view["stats"] = _hide_counts(stats)
        del view["participants"]
    return view


def _entry_ratings(raw, keys):
    r = _clean_ratings(raw)
    return {k: round(v, 4) for k, v in r.items() if k in keys}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # 検索リクエストのみ簡潔にログ出力
        if "api/filmarks/search" in (self.path or ""):
            super().log_message(fmt, *args)

    def end_headers(self):
        # 静的ファイル（HTML/JS/CSS）はキャッシュさせない。
        # 更新が即座に反映され、古い app.js が残って不具合になるのを防ぐ。
        path = (self.path or "").split("?", 1)[0]
        if not path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_private_json(self, obj, status=200, cookies=None):
        """認証/データ用の同一オリジン向け JSON 応答。Cookie を付与でき、
        キャッシュしない。CORS ワイルドカードは付けない（Cookie と両立しないため）。"""
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for c in (cookies or []):
            self.send_header("Set-Cookie", c)
        self.end_headers()
        self.wfile.write(body)

    def _cookies(self):
        raw = self.headers.get("Cookie", "") or ""
        out = {}
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                out[k.strip()] = v.strip()
        return out

    def _current_uid(self):
        tok = self._cookies().get("session")
        return _verify_token(tok) if tok else None

    def _is_admin(self):
        uid = self._current_uid()
        if not uid or not ADMIN_USERS:
            return False
        with _data_lock:
            users = _load_users()
        u = next((v for v in users.values() if v.get("id") == uid), None)
        return bool(u) and (u.get("username") or "").lower() in ADMIN_USERS

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_LIST_BYTES:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return None

    # ---- 認証ハンドラ ----
    def _h_register(self):
        data = self._read_json_body() or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if not _valid_username(username):
            self._send_private_json({"error": "bad_username"}, 400)
            return
        if not ALLOW_REGISTER:
            self._send_private_json({"error": "registration_closed"}, 403)
            return
        if len(password) < 6:
            self._send_private_json({"error": "weak_password"}, 400)
            return
        key = username.lower()
        with _data_lock:
            users = _load_users()
            if key in users:
                self._send_private_json({"error": "exists"}, 409)
                return
            uid = secrets.token_hex(8)
            salt, h = _hash_pw(password)
            users[key] = {"id": uid, "username": username, "salt": salt,
                          "hash": h, "created": int(time.time())}
            code = _set_recovery(users[key])
            _save_users(users)
            _pwv_cache[uid] = 0
        self._send_private_json({"user": {"username": username, "hasRecovery": True}, "recoveryCode": code},
                                cookies=[_set_cookie(_make_token(uid))])

    def _user_by_uid(self, users, uid):
        return next((v for v in users.values() if v.get("id") == uid), None)

    def _h_recovery_new(self):
        uid = self._current_uid()
        if not uid:
            self._send_private_json({"error": "unauthorized"}, 401)
            return
        with _data_lock:
            users = _load_users()
            u = self._user_by_uid(users, uid)
            if not u:
                self._send_private_json({"error": "unauthorized"}, 401)
                return
            code = _set_recovery(u)
            _save_users(users)
        self._send_private_json({"recoveryCode": code, "at": u["rc_at"]})

    def _h_password_change(self):
        uid = self._current_uid()
        if not uid:
            self._send_private_json({"error": "unauthorized"}, 401)
            return
        data = self._read_json_body() or {}
        current = data.get("current") or ""
        password = data.get("password") or ""
        if len(password) < 6:
            self._send_private_json({"error": "weak_password"}, 400)
            return
        with _data_lock:
            users = _load_users()
            u = self._user_by_uid(users, uid)
            if not u or not _verify_pw(current, u.get("salt", ""), u.get("hash", "")):
                self._send_private_json({"error": "invalid_credentials"}, 401)
                return
            _bump_password(u, password)
            _save_users(users)
        self._send_private_json({"ok": True}, cookies=[_set_cookie(_make_token(uid))])

    def _h_password_reset(self):
        data = self._read_json_body() or {}
        key = (data.get("username") or "").strip().lower()
        code = _norm_recovery_code(data.get("code"))
        password = data.get("password") or ""
        now = time.time()
        tries = [t for t in _reset_tries.get(key, []) if now - t < 900]
        if len(tries) >= 5:
            self._send_private_json({"error": "too_many"}, 429)
            return
        if len(password) < 6:
            self._send_private_json({"error": "weak_password"}, 400)
            return
        with _data_lock:
            users = _load_users()
            u = users.get(key)
            ok = bool(u and u.get("rc_hash") and code and
                      _verify_pw(code, u.get("rc_salt", ""), u.get("rc_hash", "")))
            if not ok:
                tries.append(now)
                _reset_tries[key] = tries
                self._send_private_json({"error": "bad_code"}, 401)
                return
            _reset_tries.pop(key, None)
            _bump_password(u, password)
            new_code = _set_recovery(u)
            _save_users(users)
        self._send_private_json({"user": {"username": u["username"], "hasRecovery": True}, "recoveryCode": new_code},
                                cookies=[_set_cookie(_make_token(u["id"]))])

    def _h_login(self):
        data = self._read_json_body() or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        key = username.lower()
        with _data_lock:
            u = _load_users().get(key)
        if not u or not _verify_pw(password, u.get("salt", ""), u.get("hash", "")):
            self._send_private_json({"error": "invalid_credentials"}, 401)
            return
        self._send_private_json({"user": {"username": u["username"], "hasRecovery": bool(u.get("rc_hash"))}},
                                cookies=[_set_cookie(_make_token(u["id"]))])

    def _h_me(self):
        uid = self._current_uid()
        if not uid:
            self._send_private_json({"user": None})
            return
        with _data_lock:
            users = _load_users()
        u = next((v for v in users.values() if v.get("id") == uid), None)
        user = {"username": u["username"], "display": (u.get("display") or "").strip(),
                "hasRecovery": bool(u.get("rc_hash")), "recoveryAt": u.get("rc_at") or 0} if u else None
        if user and (u["username"] or "").lower() in ADMIN_USERS:
            user["admin"] = True
        self._send_private_json({"user": user})

    def _h_get_list(self):
        uid = self._current_uid()
        if not uid:
            self._send_private_json({"error": "unauthorized"}, 401)
            return
        with _data_lock:
            obj = _load_list(uid)
        self._send_private_json({"list": obj})

    def _h_save_list(self):
        uid = self._current_uid()
        if not uid:
            self._send_private_json({"error": "unauthorized"}, 401)
            return
        data = self._read_json_body()
        if not isinstance(data, dict) or not isinstance(data.get("tiers"), list):
            self._send_private_json({"error": "bad_body"}, 400)
            return
        with _data_lock:
            _save_list(uid, data)
            if _ratings_loaded:
                _ratings_cache[uid] = _ratings_from_list(data)
        self._send_private_json({"ok": True, "updatedAt": data.get("updatedAt")})

    # ---- みんなのティア・友だち比較 ----
    def _h_social_get(self):
        uid = self._current_uid()
        if not uid:
            self._send_private_json({"error": "unauthorized"}, 401)
            return
        with _data_lock:
            u = next((v for v in _load_users().values() if v.get("id") == uid), None)
        if not u:
            self._send_private_json({"error": "unauthorized"}, 401)
            return
        self._send_private_json({"share": u.get("share") or "", "display": _display_name(u),
                                 "community": u.get("community") is not False,
                                 "timeline": _timeline_settings(u), "privacy": _privacy(u)})

    def _h_social_set(self):
        uid = self._current_uid()
        if not uid:
            self._send_private_json({"error": "unauthorized"}, 401)
            return
        data = self._read_json_body() or {}
        with _data_lock:
            users = _load_users()
            u = next((v for v in users.values() if v.get("id") == uid), None)
            if not u:
                self._send_private_json({"error": "unauthorized"}, 401)
                return
            if data.get("share") == "create" and not u.get("share"):
                u["share"] = secrets.token_urlsafe(9)
            elif data.get("share") == "revoke":
                u.pop("share", None)
            if isinstance(data.get("display"), str):
                u["display"] = data["display"].strip()[:24]
            if isinstance(data.get("community"), bool):
                u["community"] = data["community"]
            tl = data.get("timeline")
            if isinstance(tl, dict):
                if isinstance(tl.get("public"), bool):
                    u["timelinePublic"] = tl["public"]
                    if tl["public"] and not u.get("timelineToken"):
                        u["timelineToken"] = secrets.token_urlsafe(9)
                if isinstance(tl.get("showAge"), bool):
                    u["timelineAge"] = tl["showAge"]
            pv = data.get("privacy")
            if isinstance(pv, dict):
                cur = _privacy(u)
                for k in PRIVACY_KEYS:
                    if isinstance(pv.get(k), bool):
                        cur[k] = pv[k]
                u["privacy"] = cur
            _save_users(users)
        self._send_private_json({"share": u.get("share") or "", "display": _display_name(u),
                                 "community": u.get("community") is not False,
                                 "timeline": _timeline_settings(u), "privacy": _privacy(u)})

    def _h_timeline(self, token):
        with _data_lock:
            u = _user_by_timeline(token)
            obj = _load_list(u["id"]) if u else None
        if not u:
            self._send_private_json({"error": "not_found"}, 404)
            return
        self._send_private_json(_public_timeline(u, obj))

    def _h_community_movie(self):
        """1作品の「みんなのティア」詳細：平均・分布・みんなの中での順位・高く評価した人が好きな作品。"""
        data = self._read_json_body() or {}
        key = data.get("key") if isinstance(data.get("key"), str) else ""
        if not key or len(key) > 300:
            self._send_private_json({"error": "bad_request"}, 400)
            return
        uid = self._current_uid()
        with _data_lock:
            _ensure_ratings()
            agg = _community_agg(exclude_uid=uid)
            users = _load_users()
            off = {u["id"] for u in users.values() if u.get("community") is False}
            raters = [r for i, r in _ratings_cache.items() if i != uid and i not in off and r.get(key, -1) >= 0.75]
        demo = False
        a = agg.get(key)
        if not a and DEMO_SOCIAL:
            a, demo = _demo_agg(key), True
        if not a:
            self._send_private_json({"agg": None, "min": COMMUNITY_MIN})
            return
        avgs = sorted((v["avg"] for k, v in agg.items() if k != key), reverse=True)
        rank = 1 + sum(1 for v in avgs if v > a["avg"])
        # この作品を高く評価した人（3人以上）が、ほかに高く評価している作品
        also = []
        if len(raters) >= COMMUNITY_MIN:
            sums = {}
            for r in raters:
                for k, sc in r.items():
                    if k == key:
                        continue
                    t = sums.setdefault(k, [0.0, 0])
                    t[0] += sc
                    t[1] += 1
            cand = [(k, t[0] / t[1], t[1]) for k, t in sums.items() if t[1] >= COMMUNITY_MIN and t[0] / t[1] >= 0.6]
            cand.sort(key=lambda x: (-x[1], -x[2]))
            also = [dict(_meta_cache.get(k) or {}, key=k, avg=round(v, 4)) for k, v, _ in cand[:12]]
        elif DEMO_SOCIAL:
            import random
            pool = [k for k, v in agg.items() if k != key and v["avg"] >= 0.6]
            rng = random.Random(hashlib.sha256(("demo-also:" + key).encode("utf-8")).hexdigest())
            pick = rng.sample(pool, min(8, len(pool)))
            also = [dict(_meta_cache.get(k) or {}, key=k, avg=agg[k]["avg"]) for k in sorted(pick, key=lambda k: -agg[k]["avg"])]
            demo = demo or bool(also)
        with _data_lock:
            comments = _movie_comments(key, exclude_uid=uid)
            extras = _movie_extras(key, exclude_uid=uid)
            kin = _movie_kin(key, uid)
        if kin["status"] == "ok" and not kin["people"] and DEMO_SOCIAL:
            kin["people"] = _demo_kin(key)
        if not extras and DEMO_SOCIAL:
            extras = _demo_extras(key)
        if not comments and DEMO_SOCIAL:
            comments = _demo_comments(key)
            demo = True
        res = {"agg": a, "rank": rank, "total": len(avgs) + 1, "also": [x for x in also if x.get("title")],
               "comments": comments, "demo": demo or bool(extras and extras.get("demo")), "min": COMMUNITY_MIN,
               "extras": _extras_public(extras, self._is_admin()) if extras else None, "kin": kin}
        if not self._is_admin():
            res["agg"] = {kk: vv for kk, vv in a.items() if kk != "count"}
        self._send_private_json(res)

    def _h_similar(self):
        data = self._read_json_body() or {}
        mine = _clean_ratings(data.get("ratings"))
        uid = self._current_uid()
        status = "need_login"
        with _data_lock:
            _ensure_ratings()
            if uid:
                u = next((v for v in _load_users().values() if v.get("id") == uid), None)
                status = "ok" if u and _privacy(u)["simPublic"] else "need_optin"
            people = _similar_people(mine, uid, status == "ok")
        self._send_private_json({"status": status, "people": people, "mine": len(mine)})

    def _h_community_lookup(self):
        data = self._read_json_body() or {}
        keys = [k for k in (data.get("keys") or []) if isinstance(k, str)][:20000]
        uid = self._current_uid()
        with _data_lock:
            _ensure_ratings()
            agg = _community_agg(exclude_uid=uid, keys=keys)
        # 作品情報の画面（1作品だけの問い合わせ）では、評価が足りない作品もデモの仮データで見せる
        if DEMO_SOCIAL and data.get("demo") and len(keys) <= 5:
            for k in keys:
                if k not in agg:
                    agg[k] = _demo_agg(k)
        if not self._is_admin():
            agg = _hide_counts(agg)
        self._send_private_json({"map": agg, "min": COMMUNITY_MIN})

    def _h_community_top(self, limit):
        uid = self._current_uid()
        with _data_lock:
            _ensure_ratings()
            agg = _community_agg(exclude_uid=uid)
            raters = sum(1 for r in _ratings_cache.values() if r)
        ranked = sorted(agg.items(), key=lambda kv: (-kv[1]["avg"], -kv[1]["count"]))[:limit]
        items = []
        for k, a in ranked:
            d = dict(_meta_cache.get(k) or {})
            d.update({"key": k}, **a)
            items.append(d)
        res = {"items": items, "min": COMMUNITY_MIN, "demo": len(_demo_users())}
        if self._is_admin():
            res["raters"] = raters
        else:
            for d in items:
                d.pop("count", None)
        self._send_private_json(res)

    def _h_demo(self):
        with _data_lock:
            chs = _demo_challenges()
        self._send_private_json({"friends": [{"name": d["display"], "token": d["share"]}
                                             for d in _demo_users() if d["share"]],
                                 "challenges": [{"id": c["id"], "title": c["title"], "creator": c["creator"]}
                                                for c in chs.values()]})

    def _h_compare(self, token):
        data = self._read_json_body() or {}
        mine = _clean_ratings(data.get("ratings"))
        with _data_lock:
            friend = _user_by_share(token)
            if not friend:
                self._send_private_json({"error": "not_found"}, 404)
                return
            _ensure_ratings()
            friend_ratings = dict(_ratings_cache.get(friend["id"]) or {})
            is_self = friend["id"] == self._current_uid()
        res = _compare(friend_ratings, mine)
        pv = _privacy(friend)
        hidden = [sec for sec, flag in (("both", "cmpBoth"), ("split", "cmpSplit"), ("recs", "cmpRecs")) if not pv[flag]]
        for sec in hidden:
            res[sec] = []
        res.update({"name": _display_name(friend), "self": is_self, "hidden": hidden})
        self._send_private_json(res)

    def _h_challenge_create(self):
        data = self._read_json_body() or {}
        title = _s(data.get("title"), 60)
        pid = data.get("pid") if isinstance(data.get("pid"), str) else ""
        movies = _clean_challenge_movies(data.get("movies"))
        if not title or len(movies) < 2 or not PID_RE.match(pid):
            self._send_private_json({"error": "bad_request"}, 400)
            return
        name = _s(data.get("name"), 24) or "名無しさん"
        keys = {m["key"] for m in movies}
        ch = {"id": secrets.token_urlsafe(6), "title": title, "note": _s(data.get("note"), 200),
              "creator": name, "ownerPid": pid, "createdAt": int(time.time() * 1000),
              "movies": movies, "entries": {}}
        ratings = _entry_ratings(data.get("ratings"), keys)
        if ratings:
            ch["entries"][pid] = {"name": name, "ratings": ratings, "at": ch["createdAt"]}
        with _data_lock:
            _save_challenge(ch)
        self._send_private_json(_challenge_view(ch, pid, self._is_admin()))

    def _h_challenge_get(self, cid, pid):
        with _data_lock:
            ch = _load_challenge(cid)
        if not ch:
            self._send_private_json({"error": "not_found"}, 404)
            return
        self._send_private_json(_challenge_view(ch, pid if PID_RE.match(pid or "") else None, self._is_admin()))

    def _h_challenge_entry(self, cid):
        data = self._read_json_body() or {}
        pid = data.get("pid") if isinstance(data.get("pid"), str) else ""
        if not PID_RE.match(pid):
            self._send_private_json({"error": "bad_request"}, 400)
            return
        with _data_lock:
            ch = _load_challenge(cid)
            if not ch:
                self._send_private_json({"error": "not_found"}, 404)
                return
            entries = ch.setdefault("entries", {})
            if pid not in entries and len(entries) >= CHALLENGE_MAX_ENTRIES:
                self._send_private_json({"error": "full"}, 409)
                return
            ratings = _entry_ratings(data.get("ratings"), {m["key"] for m in ch["movies"]})
            if not ratings:
                self._send_private_json({"error": "empty"}, 400)
                return
            entries[pid] = {"name": _s(data.get("name"), 24) or "名無しさん", "ratings": ratings,
                            "at": int(time.time() * 1000)}
            _save_challenge(ch)
        self._send_private_json(_challenge_view(ch, pid, self._is_admin()))

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/challenge":
            self._h_challenge_create()
            return
        if path.startswith("/api/challenge/") and path.endswith("/entry"):
            self._h_challenge_entry(path[len("/api/challenge/"):-len("/entry")])
            return
        if path == "/api/auth/register":
            self._h_register()
            return
        if path == "/api/auth/login":
            self._h_login()
            return
        if path == "/api/auth/recovery":
            self._h_recovery_new()
            return
        if path == "/api/auth/password":
            self._h_password_change()
            return
        if path == "/api/auth/reset":
            self._h_password_reset()
            return
        if path == "/api/auth/logout":
            self._send_private_json({"ok": True}, cookies=[_clear_cookie()])
            return
        if path == "/api/list":
            self._h_save_list()
            return
        if path == "/api/social":
            self._h_social_set()
            return
        if path == "/api/community/similar":
            self._h_similar()
            return
        if path == "/api/community/movie":
            self._h_community_movie()
            return
        if path == "/api/community/lookup":
            self._h_community_lookup()
            return
        if path.startswith("/api/compare/"):
            self._h_compare(path[len("/api/compare/"):])
            return
        self._send_private_json({"error": "not_found"}, 404)

    def _proxy_image(self, target):
        if not target.startswith(("http://", "https://")):
            self._send_json({"error": "bad_url"}, 400)
            return
        # ポスターは変わらないので端末をまたいでディスクに保存し、取得失敗時は1回だけ再試行する
        hh = hashlib.sha256(target.encode("utf-8")).hexdigest()
        img_dir = os.path.join(CACHE_DIR, "img")
        path = os.path.join(img_dir, hh)
        data, ctype = None, "image/jpeg"
        try:
            if time.time() - os.path.getmtime(path) < 30 * 24 * 3600:
                with open(path, "rb") as f:
                    data = f.read()
                with open(path + ".type", encoding="utf-8") as f:
                    ctype = f.read().strip() or ctype
        except Exception:  # noqa: BLE001
            data = None
        if data is None:
            err = None
            for attempt in range(2):
                try:
                    req = urllib.request.Request(target, headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        data = resp.read(5_000_000)
                        ctype = resp.headers.get("Content-Type", "image/jpeg")
                    break
                except Exception as exc:  # noqa: BLE001
                    err = exc
                    if attempt == 0:
                        time.sleep(0.6)
            if data is None:
                self._send_json({"error": str(err)}, 502)
                return
            if ctype.startswith("image/"):
                try:
                    os.makedirs(img_dir, exist_ok=True)
                    with open(path + ".tmp", "wb") as f:
                        f.write(data)
                    with open(path + ".type", "w", encoding="utf-8") as f:
                        f.write(ctype)
                    os.replace(path + ".tmp", path)
                except Exception:  # noqa: BLE001
                    pass
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
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
        if parsed.path == "/api/auth/me":
            self._h_me()
            return
        if parsed.path == "/api/list":
            self._h_get_list()
            return
        if parsed.path.startswith("/api/timeline/"):
            self._h_timeline(parsed.path[len("/api/timeline/"):])
            return
        if parsed.path == "/api/social":
            self._h_social_get()
            return
        if parsed.path.startswith("/api/challenge/"):
            params = urllib.parse.parse_qs(parsed.query)
            self._h_challenge_get(parsed.path[len("/api/challenge/"):], (params.get("pid") or [""])[0])
            return
        if parsed.path == "/api/demo":
            self._h_demo()
            return
        if parsed.path == "/api/community/tags":
            params = urllib.parse.parse_qs(parsed.query)
            key = (params.get("key") or [""])[0][:300]
            uid = self._current_uid()
            with _data_lock:
                res = _community_tags(key, exclude_uid=uid)
            self._send_private_json(res)
            return
        if parsed.path == "/api/community/top":
            params = urllib.parse.parse_qs(parsed.query)
            try:
                limit = max(1, min(200, int((params.get("limit") or ["60"])[0])))
            except ValueError:
                limit = 60
            self._h_community_top(limit)
            return
        if parsed.path == "/api/img":
            params = urllib.parse.parse_qs(parsed.query)
            target = (params.get("u") or [""])[0]
            self._proxy_image(target)
            return
        # データ取得元は Filmarks に一元化した。旧 映画.com 系は廃止（410 Gone）。
        if parsed.path.startswith("/api/eiga/"):
            self._send_json(
                {"error": "gone", "detail": "Use /api/filmarks/* instead.",
                 "results": []}, 410)
            return
        if parsed.path == "/api/filmarks/search":
            params = urllib.parse.parse_qs(parsed.query)
            query = (params.get("q") or [""])[0].strip()
            media = (params.get("media") or [""])[0].strip()
            if not query:
                self._send_json({"error": "empty_query", "results": []}, 400)
                return
            try:
                if media in SERIES_PATH:
                    lim = (params.get("limit") or ["20"])[0]
                    quick = (params.get("quick") or [""])[0] == "1"
                    self._send_json({"results": filmarks_series_search(
                        query, media, max(1, min(20, int(lim) if lim.isdigit() else 20)), not quick)})
                    return
                self._send_json({"results": filmarks_search(query)})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": []}, 502)
            return
        if parsed.path == "/api/filmarks/series_coming":
            params = urllib.parse.parse_qs(parsed.query)
            media = (params.get("media") or [""])[0]
            if media not in SERIES_PATH:
                self._send_json({"error": "bad_params", "results": []}, 400)
                return
            try:
                self._send_json({"results": filmarks_series_coming(media)})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": []}, 502)
            return
        if parsed.path == "/api/filmarks/series_list":
            params = urllib.parse.parse_qs(parsed.query)
            media = (params.get("media") or [""])[0]
            kind = (params.get("kind") or [""])[0]
            value = (params.get("value") or [""])[0]
            start = (params.get("start") or ["1"])[0]
            pages = (params.get("pages") or ["2"])[0]
            if media not in SERIES_PATH or (kind != "trend" and not value.isdigit()):
                self._send_json({"error": "bad_params", "results": []}, 400)
                return
            try:
                results, has_more = filmarks_series_list(
                    media, kind, value,
                    max(1, int(start) if start.isdigit() else 1),
                    max(1, min(4, int(pages) if pages.isdigit() else 2)))
                self._send_json({"results": results, "hasMore": has_more})
            except ValueError:
                self._send_json({"error": "bad_params", "results": []}, 400)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": []}, 502)
            return
        if parsed.path == "/api/filmarks/year":
            params = urllib.parse.parse_qs(parsed.query)
            year = (params.get("year") or [""])[0].strip()
            if not re.fullmatch(r"\d{4}", year):
                self._send_json({"error": "bad_year", "results": []}, 400)
                return
            pages_raw = (params.get("pages") or ["3"])[0].strip()
            pages = int(pages_raw) if pages_raw.isdigit() and int(pages_raw) >= 1 else 3
            pages = min(pages, 6)  # 1リクエストあたりの取りすぎ防止
            from_raw = (params.get("from") or ["1"])[0].strip()
            start = int(from_raw) if from_raw.isdigit() and int(from_raw) >= 1 else 1
            try:
                results, has_more = filmarks_year(int(year), start, pages)
                self._send_json({"results": results, "hasMore": has_more,
                                 "from": start, "pages": pages})
            except urllib.error.HTTPError as exc:
                if exc.code in (404, 410):
                    self._send_json({"results": [], "unavailable": True})
                else:
                    self._send_json({"error": str(exc), "results": []}, 502)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": []}, 502)
            return
        if parsed.path == "/api/filmarks/release_year":
            params = urllib.parse.parse_qs(parsed.query)
            year = (params.get("year") or [""])[0].strip()
            if not re.fullmatch(r"\d{4}", year):
                self._send_json({"error": "bad_year", "results": []}, 400)
                return
            pages_raw = (params.get("pages") or ["3"])[0].strip()
            pages = int(pages_raw) if pages_raw.isdigit() and int(pages_raw) >= 1 else 3
            pages = min(pages, 12)  # 1リクエストあたりの取りすぎ防止
            from_raw = (params.get("from") or ["1"])[0].strip()
            start = int(from_raw) if from_raw.isdigit() and int(from_raw) >= 1 else 1
            try:
                results, has_more = filmarks_release_year(int(year), start, pages)
                self._send_json({"results": results, "hasMore": has_more,
                                 "from": start, "pages": pages})
            except urllib.error.HTTPError as exc:
                if exc.code in (404, 410):
                    self._send_json({"results": [], "unavailable": True})
                else:
                    self._send_json({"error": str(exc), "results": []}, 502)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": []}, 502)
            return
        if parsed.path == "/api/filmarks/coming":
            params = urllib.parse.parse_qs(parsed.query)
            pages_raw = (params.get("pages") or ["4"])[0].strip()
            pages = int(pages_raw) if pages_raw.isdigit() and int(pages_raw) >= 1 else 4
            pages = min(pages, 10)  # 1リクエストあたりの取りすぎ防止
            from_raw = (params.get("from") or ["1"])[0].strip()
            start = int(from_raw) if from_raw.isdigit() and int(from_raw) >= 1 else 1
            try:
                results, has_more = filmarks_coming(start, pages)
                self._send_json({"results": results, "hasMore": has_more,
                                 "from": start, "pages": pages})
            except urllib.error.HTTPError as exc:
                if exc.code in (404, 410):
                    self._send_json({"results": [], "unavailable": True})
                else:
                    self._send_json({"error": str(exc), "results": []}, 502)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": []}, 502)
            return
        if parsed.path == "/api/filmarks/genre":
            params = urllib.parse.parse_qs(parsed.query)
            genre = (params.get("genre") or [""])[0].strip()
            if not genre.isdigit():
                self._send_json({"error": "bad_genre", "results": []}, 400)
                return
            pages_raw = (params.get("pages") or ["3"])[0].strip()
            pages = int(pages_raw) if pages_raw.isdigit() and int(pages_raw) >= 1 else 3
            pages = min(pages, 6)  # 1リクエストあたりの取りすぎ防止
            from_raw = (params.get("from") or ["1"])[0].strip()
            start = int(from_raw) if from_raw.isdigit() and int(from_raw) >= 1 else 1
            try:
                results, has_more = filmarks_genre(genre, start, pages)
                self._send_json({"results": results, "hasMore": has_more,
                                 "from": start, "pages": pages})
            except urllib.error.HTTPError as exc:
                if exc.code in (404, 410):
                    self._send_json({"results": [], "unavailable": True})
                else:
                    self._send_json({"error": str(exc), "results": []}, 502)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": []}, 502)
            return
        if parsed.path == "/api/filmarks/award_members":
            # 受賞作の一覧（登録本数の集計用）。各賞の全ページをまとめて返す（ページは1日キャッシュ）
            params = urllib.parse.parse_qs(parsed.query)
            paths = [p for p in (params.get("paths") or [""])[0].split(",") if re.fullmatch(r"\d+(/\d+)?", p)][:30]
            members = {}
            for p in paths:
                try:
                    res, _ = filmarks_award(p, 1, 8)
                    members[p] = [{"id": r["id"], "title": r["title"]} for r in res]
                except Exception:  # noqa: BLE001
                    members[p] = []
            self._send_json({"members": members})
            return
        if parsed.path == "/api/filmarks/award":
            params = urllib.parse.parse_qs(parsed.query)
            path = (params.get("path") or [""])[0].strip()
            if not re.fullmatch(r"\d+(/\d+)?", path):
                self._send_json({"error": "bad_path", "results": []}, 400)
                return
            pages_raw = (params.get("pages") or ["3"])[0].strip()
            pages = int(pages_raw) if pages_raw.isdigit() and int(pages_raw) >= 1 else 3
            pages = min(pages, 6)  # 1リクエストあたりの取りすぎ防止
            from_raw = (params.get("from") or ["1"])[0].strip()
            start = int(from_raw) if from_raw.isdigit() and int(from_raw) >= 1 else 1
            try:
                results, has_more = filmarks_award(path, start, pages)
                self._send_json({"results": results, "hasMore": has_more,
                                 "from": start, "pages": pages})
            except urllib.error.HTTPError as exc:
                if exc.code in (404, 410):
                    self._send_json({"results": [], "unavailable": True})
                else:
                    self._send_json({"error": str(exc), "results": []}, 502)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": []}, 502)
            return
        if parsed.path == "/api/filmarks/movie_genres":
            params = urllib.parse.parse_qs(parsed.query)
            raw = (params.get("titles") or [""])[0]
            try:
                items = json.loads(raw) if raw else []
                # 文字列配列でも {title,year} 配列でも受け付ける
                items = [({"title": x} if isinstance(x, str) else x) for x in items]
            except Exception:
                self._send_json({"error": "bad_titles", "results": {}}, 400)
                return
            if not items:
                self._send_json({"error": "no_titles", "results": {}}, 400)
                return
            try:
                self._send_json({"results": batch_movie_genres(items)})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": {}}, 502)
            return
        if parsed.path == "/api/watch":
            params = urllib.parse.parse_qs(parsed.query)
            title = (params.get("title") or [""])[0].strip()
            year = (params.get("year") or [""])[0].strip()
            fid = (params.get("fid") or [""])[0].strip()
            if not title:
                self._send_json({"error": "empty_title", "offers": []}, 400)
                return
            try:
                res = justwatch_watch(title, year)
                res["cinema"] = theater_status(title, year, fid)
                self._send_json(res)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "offers": []}, 502)
            return
        if parsed.path == "/api/filmarks/details":
            params = urllib.parse.parse_qs(parsed.query)
            raw = (params.get("ids") or [""])[0].strip()
            ids = [x for x in raw.split(",") if x.isdigit() or RE_SERIES_FID.match(x)]
            if not ids:
                self._send_json({"error": "no_ids", "results": {}}, 400)
                return
            try:
                self._send_json({"results": batch_filmarks_details(ids)})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": {}}, 502)
            return
        if parsed.path == "/api/filmarks/person/search":
            params = urllib.parse.parse_qs(parsed.query)
            query = (params.get("q") or [""])[0].strip()
            if not query:
                self._send_json({"error": "empty_query", "results": []}, 400)
                return
            try:
                self._send_json({"results": filmarks_person_search(query)})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": []}, 502)
            return
        if parsed.path == "/api/filmarks/person/movies":
            params = urllib.parse.parse_qs(parsed.query)
            pid = (params.get("id") or [""])[0].strip()
            if not pid.isdigit():
                self._send_json({"error": "bad_id", "results": []}, 400)
                return
            try:
                self._send_json({"results": filmarks_person_movies(pid)})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "results": []}, 502)
            return
        if not self._static_allowed():
            return
        super().do_GET()

    def do_HEAD(self):
        if not self._static_allowed():
            return
        super().do_HEAD()

    def _static_allowed(self):
        """フロントが使うファイルだけを配信し、それ以外（data/ 等）は 404。"""
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html") or path in STATIC_FILES:
            return True
        self.send_error(404)
        return False


STATIC_FILES = {
    "/app.js", "/styles.css", "/icons.js", "/sw.js", "/manifest.webmanifest",
    "/icon.svg", "/icon-pop.svg",
    "/icons/apple-touch-icon.png", "/icons/icon-192.png", "/icons/icon-512.png",
    "/icons/icon-app.svg", "/icons/icon-maskable-512.png",
    "/terms.html", "/privacy.html", "/legal.css",
}


def _lan_ip():
    """このマシンの LAN IP（192.168.x など）を推定して返す。取得できなければ空。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))  # 実際には送信しない。経路上のローカルIPを得るだけ
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:  # noqa: BLE001
        return ""


def _tailscale():
    """Tailscale の IPv4 と MagicDNS 名（分かれば）を返す。未導入なら (None, None)。"""
    ip = dns = None
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True,
                             text=True, timeout=3)
        if out.returncode == 0:
            ip = (out.stdout.strip().splitlines() or [""])[0].strip() or None
    except Exception:  # noqa: BLE001
        return None, None
    try:
        st = subprocess.run(["tailscale", "status", "--json"], capture_output=True,
                            text=True, timeout=3)
        if st.returncode == 0:
            data = json.loads(st.stdout)
            dns = (data.get("Self", {}) or {}).get("DNSName", "").rstrip(".") or None
    except Exception:  # noqa: BLE001
        pass
    return ip, dns


def _print_startup():
    line = "─" * 56
    print(line)
    print(f"  🎬 Tiari を起動しました（ポート {PORT}）")
    print(line)
    print(f"  このMacで見る       : http://localhost:{PORT}")
    lan = _lan_ip()
    if lan:
        print(f"  自宅Wi-Fi内の端末で : http://{lan}:{PORT}")
    ts_ip, ts_dns = _tailscale()
    if ts_ip:
        print()
        print("  ── 外出先からスマホで使う（Tailscale） ──")
        print(f"  ・スマホにも Tailscale を入れて同じアカウントでログイン")
        print(f"  ・簡易接続（HTTP）  : http://{ts_ip}:{PORT}")
        print(f"  ・アプリ化する場合は HTTPS が必要です。別ターミナルで次を実行：")
        print(f"        tailscale serve --bg {PORT}")
        if ts_dns:
            print(f"    → スマホで https://{ts_dns}/ を開く（ホーム画面に追加でアプリ化）")
        else:
            print(f"    → 表示された https://<マシン名>.ts.net/ を開く")
    else:
        print()
        print("  外出先から使うには Tailscale の導入がおすすめです（README 参照）。")
    print(line)
    print("  停止するには Ctrl+C。")
    print(line)
    sys.stdout.flush()


def main():
    if REMOTE_ON:
        _remote_restore()
        threading.Thread(target=_remote_worker, daemon=True).start()
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        print(f"ポート {PORT} はすでに使用中です（Tiari が起動済みの可能性があります）。")
        print(f"  そのまま使う : http://localhost:{PORT} を開く")
        print(f"  再起動する   : lsof -ti tcp:{PORT} | xargs kill  を実行してから再度起動")
        sys.exit(1)
    _print_startup()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n停止しました。")
        server.server_close()


if __name__ == "__main__":
    main()
