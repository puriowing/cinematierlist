#!/usr/bin/env python3
"""手元の data/users.json と data/lists/*.json を GitHub のデータ用リポジトリへ送る（初回移行用）。

使い方:
    python3 upload_data.py
    → トークンを聞かれるので貼り付けて Enter（画面には表示されません）
"""
import getpass
import glob
import os
import subprocess
import sys
import urllib.error

def _clipboard():
    try:
        return subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=3).stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


token = os.environ.get("GITHUB_TOKEN") or ""
if not token and _clipboard().startswith(("github_pat_", "ghp_")):
    token = _clipboard()
    print("コピー中のトークンを使います")
if not token:
    token = getpass.getpass("トークンを貼り付けて Enter（表示されません）: ").strip()
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
    try:
        server._remote_upload(rel)
    except urllib.error.HTTPError as e:
        hint = {401: "トークンが正しくないか、期限切れです",
                403: "トークンに tierlist-data の Contents（Read and write）の権限がありません",
                404: "リポジトリが見つからないか、トークンの対象に tierlist-data が入っていません"}
        sys.exit(f"送信に失敗しました（{e.code}）：{hint.get(e.code, e.reason)}")
    print("送信しました:", rel)
print(f"完了しました（{repo}）")
