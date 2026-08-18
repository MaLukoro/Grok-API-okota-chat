# Grok Kotatsu

Grok API 専用の、iPhone 単体で動く長編チャット PWA。  
Local LLM Studio のログ JSON と行き来できる。PC でサーバーを常駐させる必要はない。

場所: `C:\Users\kyuri\Desktop\grok-kotatsu`

## できること（MVP）

1. xAI APIキー + ストリーミングチャット
2. 会話は IndexedDB に永続（閉じても続きから）
3. プロジェクト + 資料ファイル
4. composer 上の「📁 参照」（全選択 / 一部 / 空=RAGオフ）
5. ブラウザ内 TF-IDF 簡易 RAG
6. 既存アプリと同じ JSON のインポート / エクスポート
7. Rex ボイス読み上げ（xAI TTS、失敗時は端末音声）
8. PWA（ホーム画面追加・standalone）
9. Supabase への手動バックアップ、または全データ JSON

やらない: Local LLM / LM Studio / start.bat 依存 / 重いベクトル検索

## まろ向け：iPhone で使う手順

iOS のホーム画面アプリにするには **HTTPS の URL** が必要。

### 本命：GitHub Pages（Cloudflare 不要）

1. [GitHub](https://github.com/new) で新しいリポジトリを作る（例: `grok-kotatsu`、Public で OK）
2. **Add file → Upload files** で、このフォルダの中身を全部上げる  
   （フォルダごと入れ子にしない。`index.html` がリポジトリの一番上に見えること）
3. Commit
4. リポジトリの **Settings → Pages**
   - Source: **Deploy from a branch**
   - Branch: `main`（なければ `master`）/ フォルダは **/ (root)**
   - Save
5. 1〜2分待つ。`https://（自分のID）.github.io/grok-kotatsu/` が出る
6. iPhone の Safari でその URL を開く → 共有 → **ホーム画面に追加**
7. ⚙ で xAI APIキーを保存 → 接続テスト

GitHub Pages は静的配信だけ。チャットは `api.x.ai` 直結。  
接続テストが **CORS** で落ちたら、設定のプロキシ URL が要る（下の「チャットが弾かれたとき」）。

### Cloudflare のフォルダアップロードが怒られた人へ

`wrangler.toml` が「ビルドが要るプロジェクト」判定を踏んでた。もう消してある。  
もう一度 CF にドロップしたいなら、**中身だけ**（`index.html` が見える状態）を Upload assets すれば通るはず。

### チャットが弾かれたとき（プロキシ）

GitHub Pages 上で接続テストが失敗するなら、ブラウザが `api.x.ai` を CORS で止めてる。

1. Cloudflare の **Workers**（Pages のアップロードじゃない）を開く
2. `worker.js` の中身を貼ってデプロイ
3. 出てきた `https://xxxx.workers.dev/v1` を ⚙ のプロキシ URL に入れる

### PC で中身を見るだけ

### PC で中身を見るだけ

```bat
cd C:\Users\kyuri\Desktop\grok-kotatsu
python preview.py
```

ブラウザで http://127.0.0.1:8765/  
この preview だけがローカル用。本番の iPhone 運用には使わない。

## 設定

| 項目 | 場所 |
|------|------|
| APIキー | ⚙ → xAI API（端末の localStorage） |
| モデル | 既定 `grok-4.20-0309-non-reasoning`。4.6 / 4.5 / 4.20 reasoning も選べる |
| 参照 | プロジェクトを開くと composer 上に 📁 参照 |
| Rex | 各返答の 🔊、または上部スピーカー。速度スライダーあり |
| クラウド | Supabase URL + anon key。初回だけ設定内の SQL を実行 |

## JSON 互換

既存 Local LLM Studio の `chats/*.json` を 📂 再開 にそのまま落とせる。

```
id, title, system_prompt, model, project_id, messages, created_at, updated_at, version
```

書き出しも同じ形。`pinned` は Kotatsu 側の追加フィールドで、向こうは無視する。

## ファイル構成

```
grok-kotatsu/
  index.html              UI
  styles.css              おこた色のダーク
  manifest.webmanifest    PWA
  sw.js                   オフライン用シェル
  preview.py              ローカル確認 + /v1 プロキシ
  worker.js               Cloudflare Worker プロキシ
  functions/v1/[[path]].js  Pages 用プロキシ
  icons/                  ホーム画面アイコン
  js/
    app.js                画面と配線
    db.js                 IndexedDB
    xai.js                chat / models / tts
    rag.js                TF-IDF
    importChat.js         JSON 正規化
    tts.js                Rex 読み上げ
    cloud.js              Supabase
    settings.js           localStorage
    util.js
```

## 注意

- APIキーは端末の中だけ。リポジトリに書かない。
- 家の Wi-Fi 以外に Pages URL を配ると、キーを入れた人が課金される。自分用。
- 画像付き multimodal 履歴はテキスト化して読む。初版は画像生成なし。
- JS を触ったら `index.html` の `?v=` と `sw.js` の `CACHE` を上げること。
