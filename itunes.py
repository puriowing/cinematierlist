import json, urllib.parse

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
             "poster": _art(r), "year": (r.get("releaseDate") or "")[:4]} for r in rs if r.get("collectionId")]

def artist_songs(artist_id, limit=200):
    rs = fetch_json(_url("lookup", id=artist_id, entity="song", limit=limit))["results"]
    name = next((r.get("artistName") for r in rs if r.get("wrapperType") == "artist"), "")
    return {"artist": name, "songs": _songs(rs)}

def album_songs(collection_id):
    rs = fetch_json(_url("lookup", id=collection_id, entity="song"))["results"]
    head = next((r for r in rs if r.get("wrapperType") == "collection"), {})
    return {"album": head.get("collectionName") or "", "artist": head.get("artistName") or "", "songs": _songs(rs)}
