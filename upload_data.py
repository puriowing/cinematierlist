#!/usr/bin/env python3
"""手元の data/users.json と data/lists/*.json を GitHub のデータ用リポジトリへ送る（初回移行用）。

使い方:
    python3 upload_data.py
    → トークンを聞かれるので貼り付けて Enter（画面には表示されません）
"""
import getpass
import glob
import os
import sys

token = os.environ.get("GITHUB_TOKEN") or getpass.getpass("トークンを貼り付けて Enter（表示されません）: ").strip()
repo = os.environ.get("DATA_REPO") or "puriowing/tierlist-data"
if not token.isascii() or not token.startswith(("github_pat_", "ghp_")):
    sys.exit("トークンの形式が正しくありません（github_pat_ で始まる文字列を貼り付けてください）")
os.environ["GITHUB_TOKEN"], os.environ["DATA_REPO"] = token, repo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

files = [server.USERS_PATH] + glob.glob(os.path.join(server.LISTS_DIR, "*.json"))
for path in files:
    if not os.path.exists(path):
        continue
    rel = os.path.relpath(path, server.DATA_DIR).replace(os.sep, "/")
    server._remote_upload(rel)
    print("送信しました:", rel)
print(f"完了しました（{repo}）")
