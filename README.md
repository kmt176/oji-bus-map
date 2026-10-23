# oji-bus-map

王子駅周辺の都営バスの乗り場と路線を地図で見るアプリ（GitHub Pages で公開）。

- `index.html` … 地図ページ（Leaflet + OpenStreetMap）。先頭の `GAS_URL` に Apps Script のデプロイ URL を入れる
- `gas/Code.gs` … ODPT のデータ中継（Apps Script）。キーはスクリプトプロパティ `ODPT_KEY`、6時間キャッシュ

## Apps Script の設定
1. プロジェクト「王子駅バス地図」に `gas/Code.gs` の中身を貼り付ける
2. スクリプトプロパティに `ODPT_KEY` を登録（済み）
3. エディタで `testBuild` を実行し、ログに件数が出ることを確認
4. デプロイ →「ウェブアプリ」／実行ユーザー「自分」／アクセスできるユーザー「全員」
5. エディタで `setupTrigger` を一度実行（5時間ごとにデータを先に作るトリガーができる。初回は許可を求められる）
6. 出てきた URL（…/exec）を `index.html` の `GAS_URL` に入れる

## 遅れ・運休の表示
- `?type=status` で路線ごとの遅れを返す。都営バスの位置データ（odpt:Bus）が最後に出た乗り場の時刻と、時刻表（odpt:BusTimetable）を比べる
- 走っているはずの便が2本以上あるのに位置データに1台もないときは「運休の可能性※」（推測）
- 赤くする遅れの分数は `index.html` 先頭の `DELAY_ALERT_MIN`（初期値10分）、更新間隔は `STATUS_INTERVAL_SEC`（150秒）
- エディタで `testStatus` を実行すると、推定結果がログに出る

路線の線は OSRM（router.project-osrm.org）で道路に沿わせている。取れない区間は直線になる。

URL の末尾に `?refresh=1` を付けて開くと、キャッシュを使わずに取り直す。
