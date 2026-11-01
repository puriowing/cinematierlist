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

def _song(r, en=None):
    title = clean_title(r.get("trackName"))
    return {
        "itunesId": str(r.get("trackId") or ""), "title": title,
        "keyTitle": clean_title((en or {}).get(r.get("trackId"))) or title,
        "artist": r.get("artistName") or "", "album": r.get("collectionName") or "",
        "poster": _art(r), "year": (r.get("releaseDate") or "")[:4],
        "genres": [g for g in [r.get("primaryGenreName")] if g],
        "previewUrl": r.get("previewUrl") or "", "appleUrl": r.get("trackViewUrl") or "",
    }

_KEY_STRIP = re.compile(r"[\s・:：\-－—―~〜!！?？'\"“”‘’「」『』()（）\[\]【】.,、。]")


# app.js の VERSION_TAG_W と同じ（tests で一致を確認）。リマスター・リミックス・Edit・〜Version・Live・Acoustic・
# Instrumental・TV size・FIRST TAKE・Demo・English ver. などの違いは同じ曲として扱う。Cover・カラオケは別の曲のまま
_C = r"[^()\[\]【】]"
_TAG_BASE = (r"(?:(?:mono|stereo)\s*[;/]\s*)?(?:'?(?:\d{4}|\d{2})\s*(?:-\s*)?)?(?:digital\s+|new\s+)?(?:remaster(?:ed|ing)?|リマスター|リマスタリング)(?:\s*\d{4})?(?:\s*(?:version|ver\.?|バージョン|版))?"
             r"|mono|stereo|original|オリジナル")
_TAG_VARIANT = (r"(?!" + _C + r"*(?:cover|カバー|karaoke|カラオケ))"
                r"(?:" + _C + r"*(?:remix(?:ed)?|リミックス|ミックス|バージョン)"
                r"|(?:" + _C + r"*[^a-z()\[\]【】])?(?:mix|edit|version|ver\.?)"
                r"|(?:" + _C + r"*[^a-z()\[\]【】])?(?:live|acoustic|instrumental|inst\.?|demo|first\s*take|tv\s*size)(?![a-z])" + _C + r"*"
                r"|" + _C + r"*(?:ライブ|ライヴ|アコースティック|インスト|デモ|tv\s*サイズ|テレビサイズ|英語)" + _C + r"*"
                r"|" + _C + r"*\s-\s*remaster(?:ed)?(?:\s*\d{4})?"
                r"|re-?recorded)")
_TAG = "(?:" + _TAG_BASE + "|" + _TAG_VARIANT + ")"


def _tag_re(tag):
    return re.compile(r"(?:\s*\(\s*" + tag + r"\s*\)|\s*\[\s*" + tag + r"\s*\]|\s*【\s*" + tag + r"\s*】|\s+-\s+" + tag + r")+$")


VERSION_TAG = _tag_re(_TAG)
_BASE_TAG = _tag_re("(?:" + _TAG_BASE + ")")
_VERSION_TAG_I = re.compile(VERSION_TAG.pattern, re.I)


def clean_title(v):
    """表示用の曲名：末尾の (2009 - Remaster)・(2019 Mix) などを外す。外すと空になるときは元のまま。"""
    t = v if isinstance(v, str) else ""
    return _VERSION_TAG_I.sub("", t).strip() or t


def _norm(v):
    return _KEY_STRIP.sub("", unicodedata.normalize("NFKC", v or "").lower())


def song_title_norm(v):
    t = unicodedata.normalize("NFKC", v if isinstance(v, str) else "").lower()[:200].strip()
    return _KEY_STRIP.sub("", VERSION_TAG.sub("", t))


def is_variant(v):
    """リミックス・Live・〜Version など、元の曲とは別の仕上げの曲名か（リマスターだけの違いは含めない）。"""
    t = unicodedata.normalize("NFKC", v if isinstance(v, str) else "").lower()[:200].strip()
    return VERSION_TAG.sub("", t) != _BASE_TAG.sub("", t)


_VARIOUS = {"variousartists", "various", "va", "ヴァリアスアーティスト", "オムニバス"}


_COMPILATION = re.compile(
    r"\b(?:best|greatest\s+hits|hits|collection|singles|anthology|essentials?)\b"
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
    """同じ曲が複数あるとき：リミックス等でない → オリジナルアルバム → エディション違いでない → 発売が早い → 曲数が少ない → 曲名に表記違いがない → ID が小さい。"""
    name = r.get("trackName") or ""
    return (is_variant(name),) + _album_rank(r, comps) + ((r.get("releaseDate") or "9999"), r.get("trackCount") or 9999,
                             song_title_norm(name) != _norm(name), r.get("collectionId") or 0)


def _song_artist(r):
    """「ビートルズ & ビリー・プレストン」名義の曲もアルバム側の名義（ビートルズ）でまとめる。コンピは曲の名義のまま。"""
    ca = _norm(r.get("collectionArtistName"))
    return ca if ca and ca not in _VARIOUS else _norm(r.get("artistName"))


US_CHUNK = 150
_en_titles = {}  # trackId -> 米国ストアの曲名（無ければ ""）


def english_titles(ids):
    """日本のストアは同じ曲でもカタカナ名・英語名が混ざるので、米国ストアの曲名を1回のまとめ取得で引く。失敗しても止めない。"""
    want = [i for i in dict.fromkeys(ids) if i and i not in _en_titles]
    for n in range(0, len(want), US_CHUNK):
        part = want[n:n + US_CHUNK]
        try:
            rs = fetch_json(f"{BASE}/lookup?" + urllib.parse.urlencode(
                {"id": ",".join(map(str, part)), "country": "US"}))["results"]
        except Exception:  # noqa: BLE001
            break
        if len(_en_titles) > 50000:
            _en_titles.clear()
        got = {r.get("trackId"): r.get("trackName") or "" for r in rs if r.get("wrapperType") == "track"}
        for i in part:
            _en_titles[i] = got.get(i, "")
    return {i: _en_titles[i] for i in ids if _en_titles.get(i)}


def _songs(results):
    """同じ曲は、ベスト盤より元のアルバムを優先して1つだけ残す。日本のストアの曲名か米国ストアの曲名の
    どちらかが同じ（アーティストも同じ）なら同じ曲（米国ストアはローマ字・漢字の表記が版ごとに揺れるため両方で見る）。"""
    comps = span_compilations(results)
    tracks = [r for r in results if r.get("wrapperType") == "track" and r.get("kind") == "song" and r.get("trackId")]
    en = english_titles([r["trackId"] for r in tracks]) if tracks else {}
    parent = {}

    def root(k):
        while parent.setdefault(k, k) != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    keys = []
    for r in tracks:
        a = _song_artist(r)
        ks = [(a, t) for t in dict.fromkeys(song_title_norm(n) for n in (r.get("trackName"), en.get(r["trackId"])) if n) if t]
        ks = ks or [("#", str(r["trackId"]))]
        for k in ks[1:]:
            parent[root(k)] = root(ks[0])
        keys.append(ks[0])
    best, order = {}, []
    for r, k in zip(tracks, keys):
        k = root(k)
        if k not in best:
            order.append(k)
            best[k] = r
        elif _pick_rank(r, comps) < _pick_rank(best[k], comps):
            best[k] = r
    return [_song(best[k], en) for k in order]


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


def _derive(results, q=""):
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
    name_of = {aid: min(set(ns), key=lambda n: (-ns.count(n), len(n), n)) for aid, ns in arts.items()}
    qn = _norm(q)
    match = {aid for aid, n in name_of.items() if qn and _norm(n) and (qn in _norm(n) or _norm(n) in qn)}
    top = a_order[0] if a_order else None  # 一番上の曲のアーティスト
    # 検索語と名前が一致するアーティスト → 一番上の曲のアーティスト → 曲数の多い順
    ranked = sorted(a_order, key=lambda a: (a not in match, a != top, -len(arts[a]), a_order.index(a)))
    artists = []
    for aid in ranked[:3]:
        if artists and aid not in match and aid != top and len(arts[aid]) < 2:  # 1曲だけのアーティスト（カバー等）は2番手以降に出さない
            break
        artists.append({"id": str(aid), "name": name_of[aid]})
    # アルバムの年は、手元にある収録曲のうち一番新しい発売日（アルバムはシングルより後に出る）
    rows = [dict(albs[c][0], releaseDate=max(x.get("releaseDate") or "" for x in albs[c])) for c in _rank(albs, b_order)]
    albums = _albums(rows, 8, span_compilations(tracks, min_tracks=3))
    return artists, albums


def search_all(q, limit=50):
    """曲検索1回で、曲・アーティスト・アルバムをまとめて返す。何も出ないときだけアルバム検索を1回足す。"""
    rs = fetch_json(_url("search", term=q, media="music", entity="song", limit=limit))["results"]
    songs = _songs(rs)
    artists, albums = _derive(rs, q)
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
