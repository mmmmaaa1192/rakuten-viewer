# Rakuten Auto Collector

楽天市場の商品検索順位を定期取得し、`data/state.json`へ履歴を保存します。

## 必要な環境変数

- `RAKUTEN_APPLICATION_ID`: 楽天ウェブサービスのアプリID
- `RAKUTEN_ACCESS_KEY`: 楽天ウェブサービスのアクセスキー
- `RAKUTEN_AFFILIATE_ID`: アフィリエイトID（任意）
- `COLLECTOR_ADMIN_TOKEN`: APIの更新操作に使う管理トークン（外部公開時は必須）
- `CORS_ORIGIN`: GitHub PagesからAPIへ接続する場合の許可元

## ローカル実行

```powershell
$env:RAKUTEN_APPLICATION_ID = "..."
$env:RAKUTEN_ACCESS_KEY = "..."
npm test
npm run collect
npm start
```

既定のURLは `http://127.0.0.1:8787` です。

APIサーバーを外部公開する場合は、`config`と`data`を永続ディスクへ配置し、`MONITORS_FILE`と`STATE_FILE`でそのパスを指定してください。

## 監視条件

`config/monitors.json`、またはAPIの `POST /api/monitors` で登録します。

```json
[
  {
    "id": "earphone-main",
    "keyword": "ワイヤレスイヤホン",
    "shopCode": "sample-shop",
    "itemCode": "item-001",
    "enabled": true,
    "maxPages": 4,
    "sort": "standard"
  }
]
```

`itemCode`は商品管理番号のみ、または`shop-code:item-code`形式で指定できます。空欄の場合は、対象ショップで最初に見つかった商品の順位を記録します。

## API

- `GET /api/health`
- `GET /api/state`
- `GET /api/monitors`
- `POST /api/monitors`
- `PATCH /api/monitors/:id`
- `DELETE /api/monitors/:id`
- `POST /api/collect`

更新系APIでは`Authorization: Bearer <COLLECTOR_ADMIN_TOKEN>`を送信します。トークン未設定時はループバック接続だけ更新できます。

## GitHub Actions

`.github/workflows/collect-rakuten.yml`が毎日06:17 JSTごろに実行され、取得結果を`data/state.json`へコミットします。リポジトリのActions secretsへ次を登録してください。

- `RAKUTEN_APPLICATION_ID`
- `RAKUTEN_ACCESS_KEY`
- `RAKUTEN_AFFILIATE_ID`（任意）

収集後はGitHub Pages build APIも呼び出すため、公開ダッシュボードへ最新JSONが反映されます。
