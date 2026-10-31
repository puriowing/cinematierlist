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
