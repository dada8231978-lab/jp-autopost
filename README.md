# jp-autopost (Buttondown)

日本の文化・医療に関する英語記事を Claude で生成し、Buttondown に **Paywall 付き**で自動投稿するエージェントツール。

```
記事投稿/
├── src/
│   ├── index.ts          メイン実行（トピック選定 → 生成 → 投稿 → 履歴記録）
│   ├── generator.ts      Claude による記事生成（構造化出力でスキーマ保証）
│   ├── publisher.ts      本文組み立て + Paywall 挿入
│   ├── buttondown.ts     Buttondown REST API クライアント
│   ├── verify.ts         接続確認 + 収支計算（投稿はしない）
│   ├── reddit.ts         Reddit API クライアント（OAuth2 script app）
│   ├── reddit-post.ts    記事 → Reddit向け投稿の生成 + 投稿頻度ガード
│   ├── seo.ts            公開済み記事の検索構造レポート
│   ├── topics.ts         トピックプール + 重複回避の履歴管理
│   ├── html.ts           モデル出力 HTML のサニタイズ
│   ├── config.ts         .env の検証
│   └── types.ts          記事スキーマ（zod）
├── data/history/         公開履歴（1記事=1ファイル。同時実行で衝突しない形式）
├── data/articles/        記事本文（npm run reddit が参照）
├── .github/workflows/daily-post.yml   GitHub Actions で毎日1回投稿（11:47 JST 目安）
├── scripts/run.sh / run.ps1           cron / Windows タスクスケジューラ用
├── crontab.example
└── .env.example
```

---

## なぜ Buttondown なのか

当初は Ghost で実装しましたが、**Ghost(Pro) は Admin API と Stripe 課金の両方が月$29の
Publisher プラン以上**でないと使えないことが判明したため、移行しました。

| | 固定費/月 | $5会員1人あたり純収入 | 自動投稿 | 集客力 |
|---|---|---|---|---|
| **Buttondown（採用）** | $9 | **$4.56** | ✅ 公式REST API | 弱い |
| Substack | $0 | $4.06（10%手数料） | ❌ APIなし（Playwright必須） | **強い（推薦network）** |
| Ghost(Pro) | $29 | $4.56 | ✅ 公式API | 中 |

Buttondown を選んだ決め手は**壊れにくさ**です。無人で毎日動かす前提では、Substack の
Playwright 自動化（画面変更やログイン方式で停止する）の保守コストが、月$9の差額を上回ると
判断しました。Buttondown は収益の取り分が **0%**（Stripe手数料のみ）です。

**損益分岐は有料会員2人**（$9 ÷ $4.56）。18人を超えると手数料の差で Substack より有利になります。

弱点は集客導線が無いことです。記事の公開アーカイブページを X や Reddit に流す運用で補ってください。

### 価格は $5/月

Stripe の固定費 $0.30 が効くため、$3 だと手数料率が 12.9% に達します。$5 なら 8.9% に下がり、
Substack の最低価格（$5）とも揃うため、$5 を既定にしています。

**価格そのものは Buttondown の管理画面（Settings → Paid subscriptions）で設定します。**
`.env` の `SUBSCRIPTION_PRICE_CENTS` は `npm run verify` の収支表示に使うだけで、
実際の課金額は変更しません。両者を一致させてください。

---

## セットアップ

### 1. Buttondown アカウント

1. https://buttondown.com で登録（100購読者まで無料）
2. **Settings → Paid subscriptions** で有料購読アドオン（+$9/月）を有効化し、Stripe を接続
3. 月額を **$5.00** に設定
4. **Settings → Programming → API key** をコピー

### 2. `.env` を編集

`ANTHROPIC_API_KEY` は設定済みです。追加が必要なのは1つだけ:

```
BUTTONDOWN_API_KEY=（手順1-4でコピーしたキー）
```

### 3. 接続確認

```bash
npm run verify
```

購読者数、Stripe手数料控除後の純収入、損益分岐会員数が表示されます。投稿は行いません。

---

## 使い方

**このプロジェクトに起動できるサーバーはありません。** 記事を生成して配信するCLIツールです。
エディタが `npm run dev` や `npm run start` を dev サーバーと誤認して `.claude/launch.json` を
生成することがありますが、これらのスクリプトは実際には**記事を生成して即座に公開**します。
誤って起動されないよう、`dev` / `start` は意図的に削除してあります（過去に2回生成されました）。
`.claude/launch.json` を見つけたら削除してください。

### 生成のみ（投稿しない・Buttondown不要）

```bash
npm run dry-run
```

`data/preview-<slug>.html` にプレビューが出力されます。Paywall 位置が赤い破線で表示され、
無料部分／有料部分の切れ目をブラウザで確認できます。**まずこれで品質を確認してください。**

### 下書きとして投稿

```bash
npm run post
```

既定の `BUTTONDOWN_EMAIL_STATUS=draft` では**下書きとして保存されるだけで、送信されません。**
Buttondown で内容を確認してから手動で送信してください。

### 自動送信に切り替える

出力に納得できたら `.env` を変更します。

```
BUTTONDOWN_EMAIL_STATUS=about_to_send
```

### トピック・ジャンル指定

```bash
npx tsx src/index.ts --category healthcare
npx tsx src/index.ts --topic "Why Japanese hospitals dispense drugs differently"
```

---

## Paywall と検索流入の仕組み

1記事は1通のメールとして送られ、公開アーカイブページにもなります。
`<div role="paywall"></div>` を境に自動で二分されます。

| 部分 | 誰が読めるか | 役割 |
|---|---|---|
| 無料セクション（280-420語） | **全員 + 検索エンジン** | 検索流入・新規獲得 |
| Related（内部リンク） | **全員 + 検索エンジン** | 過去記事へのクロール経路 |
| 本文（900語以上）＋要点＋免責 | 有料会員のみ | 課金対象 |

`BUTTONDOWN_EMAIL_TYPE=public` が必須です。全員にメールが届き、Paywall が読める範囲を決めます。

### 決定的な制約：Googleは無料部分しか見ていません

検索クローラーは**匿名訪問者としてページを読む**ため、Paywall より下は
一切インデックスされません。これが記事構造を規定します。

当初の設計では、無料部分は「未解決の問いで終わる導入」でした。これは購読転換には
最適ですが、**検索順位には最悪**です。Googleは「問いを投げて答えない記事」を
検索意図未充足として低く評価するためです。

そこで構造を変更しました。

| | 旧 | 新 |
|---|---|---|
| 無料部分の役割 | 引きを作る導入 | **1つの狭い問いに完全に答える独立記事** |
| 無料部分の長さ | 150-250語 | **280-420語**（薄いページは順位が付かないため） |
| 有料部分の役割 | 本文全部 | **その先の層**（機構・対立・帰結） |

**「何が起きているか」は無料で渡し、「なぜそうなるのか・何を代償にしているのか」を売る。**
これが検索順位と課金の両立点です。

### target_query（検索クエリ設計）

各記事の生成時に、Claude が狙う検索クエリを1つ決めます。実際の出力例:

```
Query : "why does japan's health insurance cover kampo herbal medicine"
Query : "can you see a specialist without a referral in japan"
Query : "why did japan remove public trash cans"
```

無料部分の**1文目がこのクエリに直接答える**よう指示しており、`meta_title` も
クエリの語を前半に配置します。

### 内部リンク（Paywall より上に配置）

公開済み記事へのリンクを `SEO_RELATED_LINKS` 件（既定3件）、**Paywall の上**に埋め込みます。
下に置くとクローラーから見えず、リンクとして機能しないためです。
これにより記事数が増えるほどクロール経路が密になり、新規ページの発見が早くなります。

### 検索構造レポート

```bash
npm run seo
```

公開済み記事の target_query、meta_title の文字数、アーカイブURLの記録状況を一覧し、
**同一クエリを狙う記事の共食い**やタイトル長超過を検出します。

順位や流入数は測定しません（ローカル履歴のみを読むため）。実データは
**Google Search Console** にアーカイブドメインを登録して確認してください。

---

## Reddit での集客（`npm run reddit`）

Buttondown には集客導線が無いため、Reddit に流す機能を用意しています。
**ただし、そのまま毎日回してはいけません。** 理由は下記の通りです。

### なぜ「毎日 r/japan に自動投稿」を作らなかったのか

Reddit の調査で判明した事実:

> "If your only Reddit activity is sharing links to your own website or product,
> Reddit considers this spam regardless of content quality."

そして**ドメイン単位のBAN**が存在します。サブレディット単位のBANは復帰できますが、
**Reddit管理者レベルでドメインBANされると全サブレディットで自分のURLが投稿不能**になり、
回復は極めて困難です。毎日リンクを投げるボットは、この状態に最短で到達します。

つまり素直に作ると、**集客チャネルを増やすどころか永久に失う**方向に働きます。
そのため以下の設計にしました。

| 設計 | 理由 |
|---|---|
| **リンク投稿ではなくテキスト投稿** | リンクだけの投稿は最もスパム判定されやすい |
| **記事の要約ではなく、独立した読み物を生成** | 「続きはリンクで」は Reddit で最も嫌われる形式 |
| **既定は下書きモード**（`--submit` を付けない限り投稿しない） | 内容を必ず人間が読んでから出す |
| **同一サブレディットへの再投稿を14日間ブロック** | 頻度がスパム判定の最大要因 |
| **宣伝表現を検出したら投稿を中止** | `subscribe` / `read more` / `newsletter` 等を正規表現で拒否 |
| **リンクは既定でオフ**（`REDDIT_INCLUDE_LINK=false`） | カルマも投稿履歴も無い状態でリンクを貼るのが一番危険 |
| **複数サブレディットをローテーション** | 単一コミュニティに反復パターンを見せない |

### 投稿先の選び方（重要）

サブレディットは「ルールの緩さ」ではなく**買い手がいるか**で選んでください。

| サブレディット | 適合理由 | 注意 |
|---|---|---|
| **r/foodforthought** | 長文記事の共有が目的の場。リンクが歓迎される稀な場所 | 中身が薄いと沈む |
| **r/TrueReddit** | 「本当に洞察のある記事」専門。読者の質が高い | **投稿時に「なぜ読む価値があるか」の説明コメントが必須** |
| **r/japan** | 日本に興味がある層が最多 | 自己宣伝の締め付けが最も厳しい |
| ~~r/japanlife~~ | — | **日本在住者専用。日本に住む人は日本の解説に課金しません。** 反応テスト用としてのみ有用 |

既定のローテーションは上位3つです。`.env` の `REDDIT_SUBREDDITS` で変更できます。
投稿先は「最後に投稿してから最も日数が経っているもの」が自動選択されます。

```bash
npm run reddit -- --sub japan   # 明示指定でローテーションを上書き
```

### セットアップ

1. https://www.reddit.com/prefs/apps で **script** タイプのアプリを作成
2. `.env` に `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USERNAME` / `REDDIT_PASSWORD` を設定
3. アカウントの状態を確認:

```bash
npm run reddit -- --whoami
```

アカウント年齢30日未満、またはコメントカルマ50未満なら警告が出ます。
**その状態で投稿しても自動フィルタで消えるだけ**なので、まず普通にコメントして
カルマを貯めてください。

### 使い方

**このプロジェクトに起動できるサーバーはありません。** 記事を生成して配信するCLIツールです。
エディタが `npm run dev` や `npm run start` を dev サーバーと誤認して `.claude/launch.json` を
生成することがありますが、これらのスクリプトは実際には**記事を生成して即座に公開**します。
誤って起動されないよう、`dev` / `start` は意図的に削除してあります（過去に2回生成されました）。
`.claude/launch.json` を見つけたら削除してください。

```bash
npm run reddit                      # 下書きを data/reddit/ に出力（投稿しない）
npm run reddit -- --sub japanlife   # 投稿先を指定
npm run reddit -- --flairs japan    # そのサブレディットのフレアID一覧
npm run reddit -- --submit          # 実際に投稿する
```

下書きは必ず読んでください。Reddit は一度スパム判定されると取り返しがつきません。

### 現実的な運用手順

1. `REDDIT_INCLUDE_LINK=false` のまま、リンク無しで数回投稿して反応を見る
2. アカウントに実績（カルマ・コメント履歴）が付いてから `REDDIT_INCLUDE_LINK=true` にする
3. 投稿間隔は最低2週間。ローテーションが自動で分散させます
4. 自分の投稿へのコメントには必ず返信する（ボット判定を避ける最も有効な手段）

**Reddit投稿は cron に入れないでください。** 記事生成は自動化に向きますが、
Reddit は人間が関与し続けないと機能しません。

---

## スケジューリング

### A. GitHub Actions（推奨・サーバー不要）

`.github/workflows/daily-post.yml` が毎日 02:47 UTC（= 11:47 JST）に実行します。

**時刻が半端なのは意図的です。** GitHub のスケジューラは同じ分に発火する全リポジトリを
キューイングするため、毎時00分は最も混雑します。実際、最初の 03:00 UTC 指定では
**07:57 UTC（約5時間遅れ）** に実行されました。半端な分にずらし、さらに13分早めることで、
通常の遅延なら 12:00 JST 前後に着地します。

ただし**分単位の正確さには依存しないでください。** GitHub はスケジュール実行の遅延を保証せず、
リポジトリが60日間無活動だとスケジュール自体を停止します。

リポジトリの **Settings → Secrets and variables → Actions** で設定:

- **Secrets**: `ANTHROPIC_API_KEY`, `BUTTONDOWN_API_KEY`
- **Variables**: 任意（すべて既定値あり）

**Secret は必ず「Repository secrets」に登録してください。** 同じページには紛らわしい登録先が
2つあり、どちらも画面上は正しく設定できたように見えます。

| 登録先 | 結果 |
|---|---|
| **Repository secrets** | ✅ 読める |
| Environment secrets | ❌ 読めない。このジョブは `environment:` を宣言していないため |
| Variables タブ | ❌ 読めない。`secrets.*` とは別物 |

送信するかどうかは Variables で切り替えられます（コード変更不要）。

| `BUTTONDOWN_EMAIL_STATUS` | 動作 |
|---|---|
| `draft` | 下書き保存のみ。内容を確認してから手動送信 |
| 未設定（既定 `about_to_send`） | 購読者へ即送信 |

`workflow_dispatch` で手動実行もでき、`dry_run` / `category` / `topic` を指定できます。
投稿履歴（`data/history/` と `data/articles/`）は自動コミットされ、トピックの重複と
内部リンク切れを防ぎます。

**手動実行を連続で2回叩かないでください。** `workflow_dispatch` の `github.sha` は起動時では
なく**ディスパッチ時**に固定されるため、2つの実行が同じコミットから始まります。以前これで
履歴が1件失われました（記事は投稿済みなのに記録だけ消える）。現在は1実行=1ファイル形式に
してあるので衝突しませんが、記事が2本出ることに変わりはありません。

### B. cron（Linux / macOS）

```bash
crontab -e
# crontab.example の内容を貼り付け、絶対パスを修正
```

### C. Windows タスクスケジューラ

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PWD\scripts\run.ps1`""
$trigger = New-ScheduledTaskTrigger -Daily -At 7:00am
Register-ScheduledTask -TaskName "DailyAutoPost" -Action $action -Trigger $trigger
```

---

## 設計上のポイント

- **構造化出力**: `output_config.format` + zod スキーマでサーバー側検証。JSON 修復処理は不要。
- **Prompt Caching**: system プロンプトをバイト単位で固定し `cache_control` を付与。
- **先に接続を検証**: 生成（課金発生）の前に Buttondown へ接続確認するため、認証ミスで
  API 料金を無駄にしません。
- **APIの仕様変更に耐える**: Buttondown がオプション項目を拒否した場合、`subject` と `body`
  だけで再送信し、警告を出して処理を続行します（毎日の無人実行が1項目の仕様変更で
  止まらないように）。
- **品質ゲート + 的確なリトライ**: 無料部分200語未満 / 有料部分700語未満は却下し、
  **どちらが失敗したかに応じた指示**を付けて再生成します（最大3回）。汎用的な
  「短すぎる」指示だと的外れな箇所を直そうとして1回分無駄になるため。
- **医療記事の免責**: `category: healthcare` の記事には自動で医療免責文を付与します。
- **HTML サニタイズ**: `<script>` / `onclick` / インラインスタイル等はホワイトリスト方式で除去。

### モデルについて

ご指定の `Claude 3.5 Sonnet` は現行 API では引退した旧世代 ID のため、後継の
**`claude-sonnet-5`** を既定にしています。実測で1記事あたり約 $0.05、毎日投稿で月約 $1.5 です。

```
ANTHROPIC_MODEL=claude-opus-5     # 最高品質（コスト約2.5倍）
ANTHROPIC_EFFORT=xhigh            # 推論の深さ: low|medium|high|xhigh|max
```

---

## 制約・既知の注意点

- **タグは送信していません。** Buttondown のタグ機能は別途 +$9/月のアドオンのため、
  生成したタグはログ表示のみです。アドオンを有効にした場合は `buttondown.ts` に
  `tags` フィールドを追加してください。
- **`status` / `email_type` の許可値は .env で変更可能**にしてあります。Buttondown 側の
  仕様が変わった場合、エラーメッセージに許可値が出るのでそれを設定してください。
- 100購読者を超えると Buttondown の基本料金が発生します（購読者数に応じた従量制）。
- **アーカイブは `buttondown.com/<username>/archive/<slug>/` に置かれます。**
  独自ドメイン化は別途 +$29/月のアドオンです。ただし新規ドメインは被リンクも
  権威もゼロなので、**初期は buttondown.com のドメイン権威に乗るほうが有利**です。
  記事が溜まって流入が出てから移行を検討してください。
- 構造化データ（JSON-LD）は実装していません。`<script>` はメール本文から除去されるため
  注入できず、サニタイザ側でも拒否しています。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `BUTTONDOWN_API_KEY is empty` | Settings → Programming → API key をコピー |
| `looks like an Anthropic key` | キーの貼り付け先が入れ替わっています |
| 400 エラーで項目名が出る | その項目を `.env` で許可値に修正。自動リトライも走ります |
| HTMLがそのまま表示される | `.env` で `BUTTONDOWN_EDITOR_MODE=fancy` に変更 |
| `stop_reason: max_tokens` | `ANTHROPIC_MAX_TOKENS` を増やす |
| 同じような記事が続く | `data/history/` を消さないこと |
| 投稿は成功したのに履歴が残らない | 手動実行を連続で叩いていないか確認。詳細はスケジューリングの項 |
| Reddit `SUBREDDIT_NOTALLOWED` | BAN済み、またはカルマ/アカウント年齢が不足 |
| Reddit `RATELIMIT` | 投稿頻度が高すぎます。日を空けてください |
| Reddit `MISSING_FLAIR` | `npm run reddit -- --flairs <sub>` でIDを取得し `.env` に設定 |
| Reddit `DOMAIN_BANNED` | そのサブレディットで自分のドメインが禁止済み。リンクを外してください |
