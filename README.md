# SUUMOスカウト

GitHub Actions で毎週月曜 9:00（JST）に自動実行し、SUUMO/LIFULL HOME'S の新着物件を
Web検索ベースでAIが評価して、Slackの `#suumo-scout` チャンネルに投稿するツールです。

## 評価条件

- エリア：港区・渋谷区・品川区・目黒区
- 家賃：10〜14万円
- 階数：8〜12階前後
- アクセス：神谷町駅または六本木一丁目駅まで35分以内
- 間取り：1LDK以上
- 夕陽：向き＋周辺の高層建物の有無をAIが推定して判定（最重要項目）

条件を変えたい場合は `scripts/scout.mjs` の冒頭にある定数（`AREAS`、`RENT_MIN`、
`RENT_MAX` など）を編集してください。

## セットアップ手順

### 1. このコードをリポジトリにpush

```bash
git init
git add .
git commit -m "Initial commit: SUUMOスカウト"
git branch -M main
git remote add origin https://github.com/<あなたのユーザー名>/suumo-scout.git
git push -u origin main
```

### 2. GitHub Secretsを登録する

リポジトリの **Settings → Secrets and variables → Actions → New repository secret**
から、以下の3つを登録してください。

| Secret名 | 値 | 取得方法 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic APIキー | [console.anthropic.com](https://console.anthropic.com/) の Settings → API Keys で発行 |
| `SLACK_BOT_TOKEN` | `xoxb-` から始まるトークン | 下記「3. Slack Botの準備」を参照 |
| `SLACK_CHANNEL_ID` | `C0BBWK83P4K`（`#suumo-scout`のID） | Slackでチャンネル名を右クリック→「チャンネル詳細を表示」の下部に表示 |

### 3. Slack Botの準備

Botがチャンネルに投稿するには、Bot Token に `chat:write` 権限が必要です。

1. [api.slack.com/apps](https://api.slack.com/apps) でアプリを作成（既にある場合はそれを使用）
2. **OAuth & Permissions** → Scopes → Bot Token Scopes に `chat:write` を追加
3. ワークスペースにインストールし、表示された `Bot User OAuth Token`（`xoxb-...`）をコピー
4. Slack上で `#suumo-scout` チャンネルにBotを **招待**（`/invite @ボット名`）

### 4. 動作確認

リポジトリの **Actions** タブ → 「SUUMOスカウト週次実行」→ **Run workflow** ボタンで
即時実行してテストできます（cronの月曜を待たずに確認可能）。

## 注意点

- SUUMO/LIFULL HOME'S はスクレイピングが利用規約で禁止されているため、このツールは
  Web検索エンジン経由で物件情報を拾う方式です。メール通知方式と比べて**新着の網羅性は
  落ちる**点をご理解ください。
- 夕陽の判定はAIの地理知識による推定です。内覧前には実際にストリートビュー等で
  確認することをおすすめします。
