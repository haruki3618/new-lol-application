# 運用ルール（API キー管理・ホスティングの見回り）

コードを触らずに、サービスを止めないための決まりごとです。**表は自分の値に書き換えて使ってください**（コピーして Notion・スプレッドシート・この Markdown のどれに置いても構いません）。

## 1. 秘密情報の台帳

キー・パスワードの**値そのものは書かない**こと。「どこにあるか」「いつ切れるか」「誰が直すか」だけを書きます。

| 名前 | 何に使う | 置き場所 | 発行日 | 期限 / 見直し日 | 直す人 |
|---|---|---|---|---|---|
| `RIOT_API_KEY`（開発キー） | Riot API | Render の Environment / GitHub Secrets / ローカル `.env` | | **発行から 24 時間** | |
| `RIOT_API_KEY`（個人用・本番用） | Riot API | 同上 | | Developer Portal の表示に従う | |
| `MONGODB_URI` | MongoDB Atlas | Render / GitHub Secrets / `.env` | | DB ユーザーのパスワード変更時 | |
| `SITE_PASSWORD` | 公開前のサイト保護 | Render | | 公開時に削除 | |
| `WEBHOOK_SECRET` | 追跡の Webhook 暗号化 | Render | | **変更すると保存済みの Webhook が復号できなくなる**（変更しない） | |
| `WATCH_REGISTER_KEY` | 追跡の登録キー | Render | | 漏れたとき | |

### キーが置かれている場所は 3 か所ある
Riot のキーを更新するときは、**使っている場所すべて**を書き換えます（1 か所だけ直して、別の場所が古いまま、がいちばん多い失敗です）。

1. ローカルの `.env`（保存すれば再起動は不要）
2. Render の Environment（保存すると自動で再デプロイされる）
3. GitHub の Settings → Secrets and variables → Actions（`crawler` / `watch` / `storage` が使う）

### 開発キーを使っている間の毎日の手順（24 時間で失効）
1. https://developer.riotgames.com/ にログインして再発行する
2. 上の 3 か所のうち使っているものを更新する
3. `/healthz` を開き、`"apiKey":"valid"` を確認する（`invalid` は失効、`unknown` は確認できていない状態）

## 2. 毎週の見回り（5 分。曜日を決める）

決まった曜日に、次を上から順に見ます。**異常があった行だけ**メモに残します。

| # | 見る場所 | 確認すること | 異常のとき |
|---|---|---|---|
| 1 | `https://<サービス名>.onrender.com/healthz` | `ok:true` / `db:"connected"` / `apiKey:"valid"` | db が切断 → Atlas の状態と `MONGODB_URI`。apiKey が invalid → 上の手順 |
| 2 | 同じ `/healthz` の `cache` | `hitRate` が極端に低くないか、`stale` が増え続けていないか | `stale` が増え続ける = Riot API 側が不調。https://developer.riotgames.com/ のステータスと `/status` を見る |
| 3 | 同じ `/healthz` の `storage` | DB の使用量が `MAX_DB_MB`（既定 400MB）に近づいていないか | 近い → `MATCH_TTL_DAYS` / `MAX_MATCHES` を下げる（`docs/DEPLOY_FREE.md`） |
| 4 | Render → Logs | `[RiotAPI] 429` や `[Route:` のエラーが急に増えていないか | 429 が多い → クローラーの枠（`RATE_LOW_RATIO`）を下げる |
| 5 | Render → Metrics | メモリが上限に張り付いていないか、再起動が繰り返されていないか | 繰り返す → ログの `uncaughtException` を確認 |
| 6 | GitHub → Actions | `test` / `crawler` / `watch` / `storage` が緑か。最後の成功が古すぎないか | 赤 → ログを開く。**60 日更新が無いと定期実行が止まる**（`keepalive` が防いでいる） |
| 7 | MongoDB Atlas | Storage の使用量、接続数 | 512MB に近い → 上の 3 |

無料枠の Render は 15 分アクセスが無いとスリープします（初回の表示が遅いのは正常）。

## 3. 毎月の見直し（10 分）
- [ ] 台帳の期限・見直し日が過ぎたものが無いか
- [ ] 依存パッケージの更新を確認する。**Dependabot が毎週月曜に Pull Request を作る**（minor / patch は 1 本にまとまる。major は個別）。GitHub の Pull requests を開き、`test` が緑なら **`docs/RELEASE_CHECKLIST.md` を通してからマージ**する。重大な警告は `test` の `npm audit` が赤くして知らせる。PR が溜まっていたら 1 か月分をまとめて見直す
- [ ] GitHub Actions の最終成功日（60 日ルール）
- [ ] 試合データの保存期間と容量の設定が、今の使い方に合っているか

## 4. 障害が起きたときの最初の 3 手
1. `/healthz` を見る（db / apiKey / rate のどれが悪いか分かる）
2. Render の Logs で直前のエラーを見る
3. 直せない・分からないときは、`/healthz` の結果とログの該当行を控えてから再デプロイ（Render → Manual Deploy）

## 5. エラー ID からログを探す
利用者が「エラー ID: `ab12cd34`」と画面に出たと教えてくれたら、Render → Logs でその ID を検索します。**1 行に原因が全部入っています**。

```
[Route:profile] 失敗: Rate limit exceeded | status=429 | endpoint=jp1:/lol/league/v4/entries/by-puuid/AbCdEfGh… | attempts=3 | req=ab12cd34 GET /summoner | riotId="Name#JP1" region="jp"
```

| 項目 | 意味 |
|---|---|
| `[Route:profile]` | どこで失敗したか（`Route:…` は画面、`Crawler` / `Watch` / `Notify` / `DB` / `Server:Process` など） |
| `status=` | 上流（Riot）や自サイトが返した番号。429 = 混雑、5xx = Riot 側の不調、401/403 = キー失効 |
| `endpoint=` | 失敗した Riot API の呼び出し先（PUUID は先頭 8 文字だけ） |
| `attempts=` | 何回やり直したか |
| `req=` | リクエスト ID（エラー画面の ID と同じ）・メソッド・パス。`riotId=` `region=` などは検索条件 |

- `status=` が無い行は、想定外のエラー（コードの不具合・DB の例外など）です。**スタックが続けて出ます**。その行とスタックを控えておいてください。
- API キー・Webhook の URL・DB のパスワードは、ログに出る前に伏せられています（`RGAPI-***` など）。
- `[Server:Process] … 再起動のために終了します` が出たら、未処理の例外が 1 分に 5 回起きて自動で再起動した印です。直前のスタックを確認してください。
- 利用者に見せるエラー ID は、**こちら側の問題（5xx・キー失効など）のときだけ**出ます。404（見つからない）や 429（混雑）には出ません。

## 6. 起動できないとき（`[Config] 起動できません`）
Render のデプロイが「Failed」になり、Logs に次のような一覧が出ます。**古い版は動き続けている**ので、慌てず直してください。

```
[Config] 起動できません。環境変数を直してから、もう一度起動してください:
  ✗ MONGODB_URI の前後に空白や引用符が含まれています
  ✗ MAX_DB_MB="400MB" は数値ではありません。このままだと既定値で動いてしまいます
```

1. Render → Environment で、該当の変数を直す（値に**引用符を付けない**・前後の空白を消す・数字だけにする）
2. 保存すると自動で再デプロイされる
3. GitHub Actions（`crawler` / `watch`）で同じ一覧が出たら、Settings → Secrets を直す
- `注意:` で始まる行は警告です（動きますが、直してください）。
- ローカルでは `RIOT_API_KEY` が無くても起動します（保存済みのデータだけ見られます）。本番・Actions・クローラーではキーが必須です。

## 7. 記録
何か変えたら、`CHANGELOG.md` に日付つきで 1 行残します。運用上の出来事（キーの更新、容量の調整、障害）は下に足してください。

| 日付 | 出来事 | 対応 |
|---|---|---|
| | | |
