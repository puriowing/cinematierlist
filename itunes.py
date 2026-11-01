import json, re, unicodedata, urllib.parse

BASE = "https://itunes.apple.com"
COMMON = {"country": "JP", "lang": "ja_jp"}

def _default_fetch(url):
    raise RuntimeError("fetch not configured")

fetch_json = _default_fetch

def _url(path, **params):
    return f"{BASE}/{path}?" + urllib.parse.urlencode({**COMMON, **params})

def _art(r):
    return (r.get("artworkUrl100") or "").replace("100x100bb", "600x600bb")

def _song(r):
    return {
        "itunesId": str(r.get("trackId") or ""), "title": r.get("trackName") or "",
        "artist": r.get("artistName") or "", "album": r.get("collectionName") or "",
        "poster": _art(r), "year": (r.get("releaseDate") or "")[:4],
        "genres": [g for g in [r.get("primaryGenreName")] if g],
        "previewUrl": r.get("previewUrl") or "", "appleUrl": r.get("trackViewUrl") or "",
    }

_KEY_STRIP = re.compile(r"[\s・:：\-－—―~〜!！?？'\"“”‘’「」『』()（）\[\]【】.,、。]")


# app.js の VERSION_TAG_W と同じ（tests で一致を確認）。リマスター・ミックス違いだけを同じ曲として扱う（Live・Remix などは別の曲）
_TAG = (r"(?:(?:(?:mono|stereo)\s*[;/]\s*)?(?:\d{4}\s*(?:-\s*)?)?(?:digital\s+)?(?:remaster(?:ed)?|リマスター|リマスタリング)(?:\s*\d{4})?(?:\s*(?:version|ver\.?|バージョン|版))?"
        r"|(?:single|album|シングル|アルバム)[\s・]*(?:version|ver\.?|バージョン)"
        r"|(?:\d{4}\s*)?(?:mono|stereo|ステレオ|モノラル|モノ)[\s・]*(?:mix|ミックス)|\d{4}\s*(?:mix|ミックス)|mono|stereo|original|オリジナル)")
VERSION_TAG = re.compile(r"(?:\s*\(\s*" + _TAG + r"\s*\)|\s*\[\s*" + _TAG + r"\s*\]|\s*【\s*" + _TAG + r"\s*】|\s+-\s+" + _TAG + r")+$")


def _norm(v):
    return _KEY_STRIP.sub("", unicodedata.normalize("NFKC", v or "").lower())


def song_title_norm(v):
    t = unicodedata.normalize("NFKC", v if isinstance(v, str) else "").lower()[:200].strip()
    return _KEY_STRIP.sub("", VERSION_TAG.sub("", t))


_VARIOUS = {"variousartists", "various", "va", "ヴァリアスアーティスト", "オムニバス"}


_COMPILATION = re.compile(
    r"\b(?:best|greatest\s+hits|hits|collection|singles|anthology|essentials?|gold)\b"
    r"|ベスト|傑作|全集|作品集|名曲集|コンプリート|シングルズ|オールタイム|\d{4}\s*[-–—~〜]\s*\d{4}")
_SECONDARY = re.compile(r"\bpast\s+masters\b|\brarities\b|\bb[\s-]?sides\b|カップリング")
_EDITION_WORD = r"(?:super\s+)?deluxe|edition|anniversary|expanded|remaster(?:ed)?|\d{4}\s*(?:re)?mix"
_EDITION = re.compile(r"\b(?:" + _EDITION_WORD + r")\b")
_EDITION_GROUP = re.compile(r"\s*[(\[（【][^()\[\]（）【】]*(?:" + _EDITION_WORD + r")[^()\[\]（）【】]*[)\]）】]")


def _album_text(name):
    return unicodedata.normalize("NFKC", name or "").lower()


def is_compilation(r):
    if _norm(r.get("collectionArtistName")) in _VARIOUS - {""}:
        return True
    t = _album_text(r.get("collectionName")).strip()
    if t.isdigit():  # 「1」のような数字だけのベスト盤。Adele「25」のような元のアルバムは曲数で見分ける
        return (r.get("trackCount") or 0) >= 20
    return bool(_COMPILATION.search(t))


def album_base(name):
    """エディション違い（Deluxe・Remastered・2019 Mix など）を除いたアルバム名。"""
    return _norm(_EDITION_GROUP.sub("", _album_text(name)))


def _edition_level(t):
    """0=無印、1=リマスターだけ、2=Deluxe・2019 Mix などのエディション違い。"""
    if not _EDITION.search(t):
        return 0
    return 1 if not _EDITION.search(re.sub(r"\bremaster(?:ed)?\b(?:\s*\d{4})?", "", t)) else 2


def span_compilations(results, min_tracks=2):
    """手元の曲データで、同じアルバムの曲の発売日が大きく離れていればベスト盤とみなす（「アンコール」「1」など名前で分からないもの）。
    3年超の開きで3曲以上、または6年超の開きで2曲以上。"""
    dates = {}
    for r in results:
        cid, d = r.get("collectionId"), (r.get("releaseDate") or "")[:10]
        if cid and len(d) == 10 and d[:4].isdigit() and r.get("wrapperType") == "track":
            dates.setdefault(cid, []).append(d)
    # 元のアルバムは新曲が同じ発売日に並ぶ（山下達郎「SOFTLY」）。同じ日付の曲が4割以上ならベスト盤とみなさない
    return {cid for cid, ds in dates.items()
            if len(ds) >= min_tracks and _span_over(min(ds), max(ds), len(ds))
            and (len(ds) < 3 or max(map(ds.count, ds)) < 0.4 * len(ds))}


def _span_over(lo, hi, n):
    y, md = int(hi[:4]) - int(lo[:4]), hi[5:] > lo[5:]
    return (n >= 3 and (y > 3 or (y == 3 and md))) or (n >= 2 and (y > 6 or (y == 6 and md)))


def _album_rank(r, comps=()):
    t = _album_text(r.get("collectionName"))
    second, level = bool(_SECONDARY.search(t)), _edition_level(t)
    # 発売日の開きによる判定は、Past Masters やデラックス盤（ボーナストラックで日付が開く）には使わない
    spread = r.get("collectionId") in comps and not second and not level
    return (is_compilation(r) or spread, second, level)


def _pick_rank(r, comps=()):
    """同じ曲が複数あるとき：オリジナルアルバム → エディション違いでない → 発売が早い → 曲数が少ない → 曲名に表記違いがない → ID が小さい。"""
    name = r.get("trackName") or ""
    return _album_rank(r, comps) + ((r.get("releaseDate") or "9999"), r.get("trackCount") or 9999,
                             song_title_norm(name) != _norm(name), r.get("collectionId") or 0)


def _song_artist(r):
    """「ビートルズ & ビリー・プレストン」名義の曲もアルバム側の名義（ビートルズ）でまとめる。コンピは曲の名義のまま。"""
    ca = _norm(r.get("collectionArtistName"))
    return ca if ca and ca not in _VARIOUS else _norm(r.get("artistName"))


def _songs(results):
    """同じ曲（アーティスト＋曲名が同じ）は、ベスト盤より元のアルバムを優先して1つだけ残す。"""
    best, order, comps = {}, [], span_compilations(results)
    for r in results:
        if r.get("wrapperType") != "track" or r.get("kind") != "song" or not r.get("trackId"):
            continue
        k = (_song_artist(r), song_title_norm(r.get("trackName"))) if r.get("trackName") else ("#", str(r["trackId"]))
        if k not in best:
            order.append(k)
            best[k] = r
        elif _pick_rank(r, comps) < _pick_rank(best[k], comps):
            best[k] = r
    return [_song(best[k]) for k in order]


def search_songs(q, limit=30):
    return _songs(fetch_json(_url("search", term=q, media="music", entity="song", limit=limit))["results"])


def _albums(rows, cap, comps=()):
    """エディション違いを1つ（無印を優先）にまとめてから、ベスト盤・コンピを除く。rows は表示順。
    comps は発売日の開きで見たベスト盤（3曲以上で判定したもの）。全部除かれるときは除かずに出す。"""
    groups, order = {}, []
    for r in rows:
        if not r.get("collectionId"):
            continue
        k = (_norm(r.get("collectionArtistName") or r.get("artistName")), album_base(r.get("collectionName")))
        if k not in groups:
            order.append(k)
            groups[k] = []
        groups[k].append(r)
    reps = [min(groups[k], key=lambda x: (_album_rank(x)[2], x.get("trackCount") or 9999, x.get("collectionId") or 0))
            for k in order]
    kept = [r for r in reps if not _album_rank(r, comps)[0]] or reps
    return [{"id": str(r["collectionId"]), "title": r.get("collectionName") or "",
             "artist": r.get("collectionArtistName") or r.get("artistName") or "",
             "poster": _art(r), "year": (r.get("releaseDate") or "")[:4]} for r in kept[:cap]]


def _rank(groups, order):
    return sorted(order, key=lambda k: (-len(groups[k]), order.index(k)))


def _derive(results):
    tracks = [r for r in results if r.get("wrapperType") == "track" and r.get("kind") == "song"]
    arts, a_order, albs, b_order = {}, [], {}, []
    for r in tracks:
        aid, cid = r.get("artistId"), r.get("collectionId")
        if aid and _norm(r.get("artistName")) not in _VARIOUS:
            if aid not in arts:
                a_order.append(aid)
            arts.setdefault(aid, []).append(r.get("artistName") or "")
        if cid:
            if cid not in albs:
                b_order.append(cid)
            albs.setdefault(cid, []).append(r)
    artists = []
    for i, aid in enumerate(_rank(arts, a_order)[:3]):
        names = arts[aid]
        if i and len(names) < 2:  # 1曲だけ出てきたアーティスト（カバー等）は2番手以降に出さない
            break
        artists.append({"id": str(aid), "name": min(set(names), key=lambda n: (-names.count(n), len(n), n))})
    # アルバムの年は、手元にある収録曲のうち一番新しい発売日（アルバムはシングルより後に出る）
    rows = [dict(albs[c][0], releaseDate=max(x.get("releaseDate") or "" for x in albs[c])) for c in _rank(albs, b_order)]
    albums = _albums(rows, 8, span_compilations(tracks, min_tracks=3))
    return artists, albums


def search_all(q, limit=50):
    """曲検索1回で、曲・アーティスト・アルバムをまとめて返す。何も出ないときだけアルバム検索を1回足す。"""
    rs = fetch_json(_url("search", term=q, media="music", entity="song", limit=limit))["results"]
    songs = _songs(rs)
    artists, albums = _derive(rs)
    if not songs or (not artists and not albums):
        albums = albums or search_albums(q, limit=8)
    return {"songs": songs, "artists": artists, "albums": albums}


def search_artists(q, limit=10):
    rs = fetch_json(_url("search", term=q, media="music", entity="musicArtist", limit=limit))["results"]
    return [{"id": str(r["artistId"]), "name": r.get("artistName") or "", "genre": r.get("primaryGenreName") or ""}
            for r in rs if r.get("artistId")]

def search_albums(q, limit=20):
    rs = fetch_json(_url("search", term=q, media="music", entity="album", limit=limit))["results"]
    return _albums(rs, limit)

def artist_songs(artist_id, limit=200):
    rs = fetch_json(_url("lookup", id=artist_id, entity="song", limit=limit))["results"]
    name = next((r.get("artistName") for r in rs if r.get("wrapperType") == "artist"), "")
    return {"artist": name, "songs": _songs(rs)}

def album_songs(collection_id):
    rs = fetch_json(_url("lookup", id=collection_id, entity="song"))["results"]
    head = next((r for r in rs if r.get("wrapperType") == "collection"), {})
    return {"album": head.get("collectionName") or "", "artist": head.get("artistName") or "", "songs": _songs(rs)}
