# TierListMaker（Pickture）

- 公開先: https://cinema-tier-list-h1bi.onrender.com（Render無料枠）。GitHub `puriowing/cinematierlist` の main に push すると Render が自動で再デプロイする。
- ファイルを変更したら、毎回 `git add -A && git commit` する（コミット時のフックで自動的に GitHub へ push される）。
- データ（アカウント・Tier List）は非公開リポジトリ `puriowing/tierlist-data` に保存。`data/` と `_debug_state.json` は絶対にコミットしない。
