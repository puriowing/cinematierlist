# TierListMaker（Tiari）

- 公開先: 映画版 https://cinema-tier-list.onrender.com（Render無料枠、Blueprint `cinematierlist` 管理）。旧URL `cinema-tier-list-h1bi` と Blueprint `cinema-tier-list` は2026-11-01に停止・不使用。GitHub `puriowing/cinematierlist` の main に push すると Render が自動で再デプロイする。
- 音楽版（tiari for Music）は同じコードを `TIARI_SITE=music` で動かす別サービス `tiari-music`。データは `puriowing/tiari-music-data`。
- Render無料枠は通信量が月5GB（ワークスペース全体で共有）。カード未登録のため超えると全サービスが止まる。
- ファイルを変更したら、毎回 `git add -A && git commit` する（コミット時のフックで自動的に GitHub へ push される）。
- データ（アカウント・Tier List）は非公開リポジトリ `puriowing/tierlist-data` に保存。`data/` と `_debug_state.json` は絶対にコミットしない。
