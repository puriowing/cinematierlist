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
