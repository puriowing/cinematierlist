#!/usr/bin/env python3
"""コピー中の GitHub トークンを確認し、有効なら GitHub への送信用として Mac のキーチェーンに保存する。"""
import subprocess
import sys
import urllib.error
import urllib.request

token = subprocess.run(["pbpaste"], capture_output=True, text=True).stdout.strip()
if not token.startswith(("github_pat_", "ghp_")):
    sys.exit("トークンがコピーされていません（github_pat_ で始まる文字列をコピーしてから実行してください）")

req = urllib.request.Request("https://api.github.com/repos/puriowing/cinematierlist",
                             headers={"Authorization": f"Bearer {token}", "User-Agent": "pickture"})
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        expiry = resp.headers.get("github-authentication-token-expiration") or "無期限"
except urllib.error.HTTPError as e:
    sys.exit(f"このトークンは使えません（{e.code}）。古いトークンをコピーしていないか確認し、作り直したものをコピーしてください")

cred = f"protocol=https\nhost=github.com\nusername=puriowing\npassword={token}\n\n"
subprocess.run(["git", "credential-osxkeychain", "store"], input=cred, text=True, check=True)
print(f"保存しました（期限: {expiry}）")
