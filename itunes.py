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


# app.js の VERSION_TAG と同じ。リマスター等の表記違いだけを同じ曲として扱う（Live・Remix などは別の曲）
_TAG = (r"(?:(?:\d{4}\s*)?(?:remaster(?:ed)?|リマスター|リマスタリング)(?:\s*\d{4})?(?:\s*(?:version|ver\.?|バージョン|版))?"
        r"|(?:single|album|シングル|アルバム)[\s・]*(?:version|ver\.?|バージョン)|mono|stereo|original|オリジナル)")
VERSION_TAG = re.compile(r"(?:\s*\(\s*" + _TAG + r"\s*\)|\s*\[\s*" + _TAG + r"\s*\]|\s*【\s*" + _TAG + r"\s*】|\s+-\s+" + _TAG + r")+$")


def _norm(v):
    return _KEY_STRIP.sub("", unicodedata.normalize("NFKC", v or "").lower())


def song_title_norm(v):
    t = unicodedata.normalize("NFKC", v if isinstance(v, str) else "").lower()[:200].strip()
    return _KEY_STRIP.sub("", VERSION_TAG.sub("", t))


def _songs(results):
    """同じ曲（アーティスト＋曲名が同じ）はシングル・アルバム・ベスト盤のうち一番古い発売のものだけ残す。"""
    best, order = {}, []
    for r in results:
        if r.get("wrapperType") != "track" or r.get("kind") != "song" or not r.get("trackId"):
            continue
        k = (_norm(r.get("artistName")), song_title_norm(r.get("trackName"))) if r.get("trackName") else ("#", str(r["trackId"]))
        if k not in best:
            order.append(k)
            best[k] = r
        elif (r.get("releaseDate") or "9999") < (best[k].get("releaseDate") or "9999"):
            best[k] = r
    return [_song(best[k]) for k in order]

def search_songs(q, limit=30):
    return _songs(fetch_json(_url("search", term=q, media="music", entity="song", limit=limit))["results"])

_VARIOUS = {"variousartists", "ヴァリアスアーティスト", "オムニバス", "various"}


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
        artists.append({"id": str(aid), "name": min(set(names), key=lambda n: (-names.count(n), len(n)))})
    albums = []
    for cid in _rank(albs, b_order)[:8]:
        r = albs[cid][0]
        albums.append({"id": str(cid), "title": r.get("collectionName") or "",
                       "artist": r.get("collectionArtistName") or r.get("artistName") or "",
                       "poster": _art(r), "year": (r.get("releaseDate") or "")[:4]})
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
    return [{"id": str(r["collectionId"]), "title": r.get("collectionName") or "", "artist": r.get("artistName") or "",
             "poster": _art(r), "year": (r.get("releaseDate") or "")[:4]} for r in rs if r.get("collectionId")]

def artist_songs(artist_id, limit=200):
    rs = fetch_json(_url("lookup", id=artist_id, entity="song", limit=limit))["results"]
    name = next((r.get("artistName") for r in rs if r.get("wrapperType") == "artist"), "")
    return {"artist": name, "songs": _songs(rs)}

def album_songs(collection_id):
    rs = fetch_json(_url("lookup", id=collection_id, entity="song"))["results"]
    head = next((r for r in rs if r.get("wrapperType") == "collection"), {})
    return {"album": head.get("collectionName") or "", "artist": head.get("artistName") or "", "songs": _songs(rs)}
