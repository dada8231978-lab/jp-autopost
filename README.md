# jp-autopost

日本の医療と文化について英語で書く著者のための、**下書き作成と公開のツール**です。

AIが担当するのは、調査メモ付きの下書きを作るところまでです。本文の書き直し、事実確認、公開の判断は著者が行います。AIの文章がほぼそのまま残っている下書きや、事実確認が済んでいない下書きは、公開コマンドが受け付けません。

> リポジトリ名に `autopost` と付いていますが、これは初期の名残です。当初は記事の生成から公開までを自動化していましたが、2026-09-11 に廃止しました（理由は後述）。

---

## 運用の流れ

```
npm run draft      →  drafts/<slug>.md に下書きができる（何も公開されない）
       ↓
自分の言葉に書き直す  →  事実を一次情報で確認して [x] を付ける
       ↓
npm run publish -- drafts/<slug>.md            公開できる状態かを確認する
npm run publish -- drafts/<slug>.md --confirm  公開する（取り消せない）
```

頻度に決まりはありません。自分で書いて確認できるペースで運用します。目安は週1本です。

---

## なぜ自動公開をやめたのか

Buttondown の審査でアカウントが承認されませんでした。同社の [Acceptable Use Policy](https://buttondown.com/legal/acceptable-use-policy) は、SEO 操作と並べて **「主に機械生成された文章や画像の共有」** を禁止しています。AIが全文を書いて検索順位を狙うという当初の設計は、この禁止事項に正面から当たっていました。

これはプラットフォームを移せば済む問題ではありません。Google の [スパムポリシー](https://developers.google.com/search/docs/essentials/spam-policies) も、**「生成AIツールなどで、ユーザーへの付加価値なしに多数のページを生成すること」** を scaled content abuse として扱い、順位の引き下げや除外の対象にしています。

そこで、AIの役割を「下書きと調査の補助」に限定し、公開までの工程に人の作業を必須にしました。

---

## 公開時のガード

`npm run publish` は、次の条件をすべて満たすまで公開しません。

| 条件 | 内容 |
|---|---|
| **書き直し** | AIの下書きと比べて、単語の `MIN_EDIT_RATIO`（既定 30%）以上が変わっていること |
| **事実確認** | 「公開前に必ず確認する事実」のチェックボックスがすべて `[x]` になっていること。記事から削った主張は、行ごと消せば条件から外れる |
| **明示的な確認** | `--confirm` を付けたときだけ送信する |

変更率は、AIの原文と書き直した本文を単語単位で比較して算出します（最長共通部分列を使います）。**ただし、これで分かるのは「どれだけ変えたか」であって「誰が書いたか」ではありません。** 目的は、AIの文章をうっかりそのまま出さないようにすることで、意図的にすり抜けることは防げません。

AIの原文は `drafts/.ai/` に保存されます。このファイルがない下書き（自分で一から作ったもの）は、書き直しの条件をチェックしません。

---

## セットアップ

1. `.env.example` を `.env` にコピーし、次の2つを設定します。
   - `ANTHROPIC_API_KEY`（下書きの生成に使います）
   - `BUTTONDOWN_API_KEY`（Buttondown → Settings → Programming → API key）
2. 接続を確認します。

```bash
npm run verify
```

PowerShell で `npm` がスクリプト実行ポリシーに拒否される場合は、`npm.cmd` を使ってください。

---

## コマンド

| コマンド | 内容 | 公開するか |
|---|---|---|
| `npm run draft` | 次のトピックで下書きを作る。`--topic "..."` や `--category healthcare` も指定可 | しない |
| `npm run publish` | 下書きの一覧と、それぞれ公開できるかを表示 | しない |
| `npm run publish -- <file>` | 1本を検査し、送信内容を表示 | しない |
| `npm run publish -- <file> --confirm` | 公開する | **する** |
| `npm run status` | 公開状況をまとめる（ターミナル表示と `data/status.html`） | しない |
| `npm run dashboard` | 状況表示と操作をブラウザで行う（`http://127.0.0.1:4173`） | 公開ボタンのみ |
| `npm run verify` | Buttondown 接続と収支の確認 | しない |
| `npm run seo` | 公開済み記事の検索構造を点検 | しない |
| `npm run reddit` | Reddit 投稿の下書きを作る（`--submit` を付けたときだけ投稿） | しない |

---

## 下書きファイルの形

```markdown
---
title: Why Japan's Overtime Cap Didn't Apply to Doctors Until 2024
slug: why-japans-overtime-cap-didnt-apply-to-doctors
category: healthcare
target_query: why did japan's overtime cap not apply to doctors
meta_description: ...
---

無料部分（検索エンジンにも見える）

<!-- PAYWALL -->

有料部分

<!-- NOTES: この行から下は公開されません -->

## 公開前に必ず確認する事実
- [ ] 医師の時間外労働の上限規制は2024年4月に適用された
- [x] （確認済みの主張）

## あなたにしか書けないこと
- 現場での実感と、報道されている数字にずれはあるか？

## 確認すべき一次情報の種類
- 厚生労働省の医師の働き方改革に関する資料
```

- `<!-- NOTES:` より下は、下書き作業のためのメモです。公開はされません。
- 冒頭にある作業手順の HTML コメントも、公開時に取り除かれます。
- メタデータ（title・slug・説明文など）は自由に書き換えて構いません。

AIには、一人称の体験談を書かないこと、出典や統計を捏造しないこと、本文に出した具体的な主張をすべて確認リストに載せることを指示しています。それでも誤りは起こりえます。**特に医療の記事は、公開する前に必ず一次情報で確かめてください。**

---

## 設定（`.env`）

| 変数 | 既定 | 内容 |
|---|---|---|
| `MIN_EDIT_RATIO` | `0.3` | 公開に必要な、AIの下書きからの変更率 |
| `TOPIC_CATEGORY` | `mixed` | `culture` / `healthcare` / `mixed` |
| `HEALTHCARE_RATIO` | `0.7` | `mixed` のときの医療の割合（直近10件で調整） |
| `SEO_RELATED_LINKS` | `3` | 無料部分の下に入れる、過去記事へのリンク数 |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | 下書きの生成に使うモデル |

---

## Paywall と検索

1本の記事は、無料部分と有料部分に分けて公開します。

| 部分 | 読める人 |
|---|---|
| 無料部分 ＋ Related（過去記事リンク） | 全員。検索エンジンもここだけを見る |
| 有料部分 ＋ 医療記事の免責文 | 有料会員のみ |

検索エンジンが読めるのは無料部分だけです。そのため無料部分は、それ単体で一つの問いに答え切る短い記事として書きます。「何が起きているか」は無料部分で答え、「なぜそうなるのか」「何を代償にしているのか」を有料部分で深掘りする構成です。

過去記事へのリンクは、公開ページが実在することを確認してから入れます。まだ下書きの記事にリンクすると404になるためです。

---

## Reddit

`npm run reddit` が作るのも、あくまで下書きです。**自分の言葉に直してから投稿してください。** AIの文章をそのまま貼り付けた投稿は、Reddit でも嫌われ、削除や BAN の対象になりえます。同じサブレディットには14日以内に再投稿できないよう制限をかけています。

---

## 課金の目安

| | |
|---|---|
| 価格 | 月額 $5（実際の価格は Buttondown → Settings → Paid subscriptions で設定） |
| 会員1人あたりの純収入 | $4.56（Stripe の手数料 2.9% + $0.30 を差し引いた額） |
| 有料購読アドオン | 月額 $9。有料会員2人で元が取れる |

---

## 注意

- **Buttondown アカウントの承認が前提です。** 承認されていない間は公開ページがすべて404になります。`npm run status` を実行すると、ニュースレター全体が404かどうかを確認できます。
- このプロジェクトに開発サーバーはありません。以前の `dev` / `start` スクリプトは、エディタのプレビュー機能が dev サーバーと誤認して記事を公開しかけたため、削除しました。
- `drafts/` は `.gitignore` の対象です。公開前の下書きは公開リポジトリに入りません。
- GitHub の Repository secrets に残っている `ANTHROPIC_API_KEY` と `BUTTONDOWN_API_KEY` は、自動実行を廃止したため使われていません。削除して構いません。

---

## ファイル構成

```
src/
├── index.ts          npm run draft — 下書きを生成
├── generator.ts      Claude への指示と、生成結果の品質チェック
├── draft-file.ts     下書きファイルの読み書き、変更率、公開前の検査
├── publish.ts        npm run publish — 検査と公開
├── publisher.ts      本文の組み立て、リンクの生存確認
├── buttondown.ts     Buttondown API クライアント
├── status.ts / status-core.ts / dashboard.ts   状況表示と操作画面
├── topics.ts         トピックの選択と公開履歴
├── reddit.ts / reddit-post.ts                  Reddit 投稿の下書き
├── seo.ts / verify.ts / config.ts / types.ts / html.ts
drafts/               作業中の下書き（git の管理外）
data/history/         公開履歴（1記事1ファイル）
data/articles/        公開した本文（Reddit ツールが読む）
```
