# Session Log — 2026-08-18

| 項目 | 内容 |
|------|------|
| 日付 | 2026-08-18 |
| プロジェクト | **Grok Kotatsu**（新規） |
| パス | `C:\Users\kyuri\Desktop\grok-kotatsu` |
| ユーザー | まろ |
| 担当 | グリク（Grok Build） |
| 状態 | **MVP 実装済み**（実機クリック確認は未。静的ファイルの HTTP 200 は確認済み） |
| 参考元 | Local LLM Studio（`C:\Users\kyuri\Desktop\app`）— コードはコピーせず、概念だけ引き継いだ別プロジェクト |
| フロントキャッシュ | `index.html` の `?v=1` / Service Worker `kotatsu-v1` |

---

## 0. 今日やったこと

Local LLM Studio とは完全に別フォルダで、**Grok API 専用・iOS スタンドアロン長編チャット PWA** を新規作成した。

目的: おこた篇などの長編 SF セッションを、PC の LM Studio / `start.bat` なしで iPhone 単体から続ける。

Node / npm が PATH に無かったので、React + Vite は使わず **ビルド不要の静的 ES modules** にした。既存アプリと同じ思想。

---

## 1. 実装方針

### 絶対条件

- ユーザーが PC サーバーを起動しなくていい
- Local LLM / LM Studio 連携は一切なし
- 会話は端末内に残る（閉じても続きから）
- 既存 `chats/*.json` と行き来できる
- プロジェクト + 参照ファイル選択（既存と同じ UX）
- Rex ボイス
- PWA（ホーム画面追加で standalone）

### 技術選択

| 項目 | 採用 | 理由 |
|------|------|------|
| フレームワーク | 素の ES modules | Node 不要。PWA / iOS が単純 |
| 永続 | IndexedDB（会話・プロジェクト・資料） | 長編向き。localStorage は設定だけ |
| 設定 | localStorage `kotatsu_settings_v1` | APIキー・モデル・声・Supabase |
| 推論 | ブラウザ → `https://api.x.ai/v1` | 同一オリジン `/v1` プロキシを優先 |
| RAG | クライアント TF-IDF | 既存 `rag.py` と同じ考え方 |
| TTS | `POST /v1/tts` `voice_id: rex` | 失敗時は `speechSynthesis` |
| クラウド | Supabase 手動 up/down | 全データ JSON 書き出しも可 |
| ローカル確認 | `preview.py`（stdlib） | 本番依存ではない |

### CORS

ブラウザから `api.x.ai` 直叩きは弾かれやすい。

- **本番:** フォルダを Cloudflare Pages に置く → `functions/v1/[[path]].js` が `/v1/*` を中継
- **予備:** `worker.js` を Worker にデプロイし、設定のプロキシ URL に入れる
- **PC確認:** `python preview.py` が `/v1` をストリーム中継

クライアントの `resolveApiBase()`:

1. 設定のプロキシ URL があればそれ
2. なければ `location.origin + "/v1"`
3. `file://` だけ直 `https://api.x.ai/v1`

### iOS 注意（既存アプリから継承）

- `crypto.randomUUID()` は HTTP で死ぬ → `makeId()` フォールバック
- 入力欄は `font-size: 16px`（ズーム防止）
- `visualViewport` で `--app-height` 追従
- 保存は送信のたび IndexedDB。`visibilitychange` / `pagehide` でも書く
- JS を触ったら `index.html` の `?v=` と `sw.js` の `CACHE` を同時に上げる

---

## 2. MVP 9項目（全部初版に入れた）

| # | 機能 | 状態 | メモ |
|---|------|------|------|
| 1 | APIキー + ストリーミングチャット | 入った | `/v1/chat/completions` SSE。Web検索 ON 時は `/v1/responses` を試し、失敗したら completions |
| 2 | IndexedDB 永続 | 入った | `chats` / `projects` / `files`。ピン留めあり |
| 3 | プロジェクト + 資料管理 | 入った | 追加・削除・JSON資料を💬でスレ化 |
| 4 | 参照ファイル選択 UI | 入った | 既存と同じ。📁参照 / すべて / なし / チェック |
| 5 | 簡易 RAG | 入った | TF-IDF。空=オフ、全選択=全資料、一部=そのファイルだけ |
| 6 | JSON import / export | 入った | 既存形式と互換。パック JSON も可 |
| 7 | Rex 読み上げ | 入った | メッセージごと + 上部 🔊。速度スライダー。自動読み上げトグル |
| 8 | PWA | 入った | manifest + SW + apple-touch-icon。standalone |
| 9 | クラウドバックアップ | 入った | Supabase 手動。設定内に初回 SQL |

追加で入れたもの:

- 会話内検索（⌕）
- Web検索トグル（Grok ツール）
- タイトル改名・削除・ピン
- 生成メタ（時間・モデル・トークン）
- RAG チップ（ヒット数・ファイル名）

---

## 3. 既存アプリから引き継いだもの

### JSON 形（export も同じ）

```
id, title, system_prompt, model, project_id,
messages[], created_at, updated_at, version
```

`messages` 要素: `role`, `content`。任意で `meta` / `rag` / `reasoning` / `attachments`。

Kotatsu 側の追加フィールド: `pinned`。向こうは無視する。

### import のゆるい正規化（`js/importChat.js`）

Local LLM Studio の `chat_store._normalize_import_payload` と同じ系統。

- 配列そのまま / `{messages}` / `{history}` / `{conversation}` / `{chats:[...]}`
- role 別名: `human`→user、`ai`/`bot`/`model`→assistant
- multimodal parts はテキスト連結
- 初版は **必ず new_id**（既存 id 上書き事故防止）
- プロジェクト開中なら `project_id` を強制セット

### 参照 UI の挙動（既存と揃えた）

| 選択 | 意味 |
|------|------|
| 未指定 / 全選択 | 全ファイルを参照（`ragSelectedSources = null`） |
| 一部 | そのファイルのチャンクだけ |
| なし（空） | RAG 完全オフ。プロジェクト system prompt だけ残る |

保持はメモリのみ。プロジェクト切替でリセット。sticky は未実装。

### RAG 注入

既存と同様、system に抜粋を足す。

- チャンク約 800 字 + overlap 120
- 日本語は unigram + bigram
- 既定 top_k=5 / max_chars=6000（Grok 向け）
- ヒットゼロのときは先頭チャンクを保険で入れる
- 1 送信の注入量に上限

---

## 4. データ

### IndexedDB `grok-kotatsu` v1

| store | key | 中身 |
|-------|-----|------|
| chats | id | 既存互換チャット + pinned |
| projects | id | name / description / system_prompt |
| files | id | project_id / name / text / mime / size |

プロジェクト削除: 資料は消す。スレッドは `project_id` を外して全体側に残す（ログを捨てない）。

### localStorage

キー: `kotatsu_settings_v1`

APIキー、プロキシ、モデル、temp / max tokens、既定 system prompt、RAG スライダー、ボイス、Supabase URL / anon key / スロット名。

### 既定モデル

`grok-4.20-0309-non-reasoning`（おこた続き用）

フォールバック一覧: 4.20 non-reasoning / 4.20 reasoning / 4.6 / 4.5 / 4.3 / 4.20 multi-agent。  
`/v1/models` が生きていればライブ一覧を優先。

既定 Temperature 0.8。既定 system prompt はグリク兄貴口調。

---

## 5. ファイル構成（実装時）

```
C:\Users\kyuri\Desktop\grok-kotatsu\
  index.html
  styles.css
  manifest.webmanifest
  sw.js
  preview.py                 ローカル確認 + /v1 ストリームプロキシ
  worker.js                  Cloudflare Worker 用プロキシ
  functions/v1/[[path]].js   Pages 用プロキシ
  wrangler.toml
  _headers
  .nojekyll
  README.md
  SESSION_LOG\SESSION_LOG_2026-08-18.md   ← 本ファイル
  icons\
    icon-192.png / icon-512.png
    apple-touch-icon.png / favicon-64.png
  js\
    app.js          画面・配線
    db.js           IndexedDB
    xai.js          chat / models / tts
    rag.js          TF-IDF
    importChat.js   JSON 正規化
    tts.js          Rex 読み上げ
    cloud.js        Supabase
    settings.js     localStorage
    util.js         makeId / escape / 表示
```

やらないと決めたこと: Local LLM、start.bat 依存、本格ベクトル検索、React 化。

---

## 6. API の叩き方

同一オリジン（Pages / preview）ならベースは `/v1`。

| 用途 | パス | メモ |
|------|------|------|
| モデル一覧 | `GET /v1/models` | 失敗時フォールバックカタログ |
| チャット | `POST /v1/chat/completions` | `stream: true` + `stream_options.include_usage` |
| Web検索 | `POST /v1/responses` + `tools: [{type:web_search}]` | 失敗したら completions に落とす |
| 読み上げ | `POST /v1/tts` | `{ text, voice_id: "rex", language: "ja" }` → audio blob |

キーは端末から `Authorization: Bearer` で送る。リポジトリには書かない。

長編保護: API に渡す履歴は古い順に落としてだいたい 350k 文字まで。IndexedDB 側の全文は残す。

---

## 7. クラウドバックアップ

Supabase テーブル（設定画面に SQL あり）:

```sql
create table if not exists kotatsu_backups (
  id text primary key,
  kind text not null default 'pack',
  title text,
  payload jsonb not null,
  updated_at timestamptz default now()
);
```

- 1 スロット = パック1個（全 chats / projects / files）
- 既定スロット名 `kotatsu-main`
- RLS は個人用で全許可。anon key は人に配らない
- 端末同士は「片方が上げて、もう片方でダウンロード」

ファイルでの全データ書き出し / 読み込みも同じパック形式（`app: "grok-kotatsu"`）。

---

## 8. 起動・デプロイ

### PC で中身を見る（本番依存ではない）

```bat
cd C:\Users\kyuri\Desktop\grok-kotatsu
python preview.py
```

http://127.0.0.1:8765/

### iPhone 本番

ホーム画面追加には **HTTPS** が要る。

1. Cloudflare Pages にこのフォルダを Upload assets
2. `https://xxxx.pages.dev` を Safari で開く
3. 共有 → ホーム画面に追加
4. ⚙ で APIキー

Pages ならプロキシ URL は空でよい。

---

## 9. 確認状況

| 項目 | 結果 |
|------|------|
| フォルダ作成・静的ファイル配置 | 済 |
| `preview.py` で HTML/JS/CSS/icon が 200 | 済（2026-08-18） |
| PC ブラウザでキー投入〜送信 | **未**（まろが試す） |
| 既存 JSON 再開 | **未** |
| iPhone PWA / Rex / Supabase | **未** |
| Chrome DevTools での画面確認 | ツール接続失敗のため未実施 |

---

## 10. 次にやりたくなりそうなこと（未着手）

| 優先 | ネタ | メモ |
|------|------|------|
| 実機 | まろ確認のフィードバック直し | 今日の本命 |
| 中 | RAG 参照のプロジェクト単位 sticky | 既存アプリでも後回しだった |
| 中 | 画像添付 / vision | 初版はテキスト中心 |
| 低 | 複数デバイスの自動同期 | 今は手動 up/down |
| 低 | JSON append（今のスレに継ぎ足し） | 既存でも事故るので入れてない |
| — | 既定モデルを 4.6 に切替 | 言われてから |

触ると死にやすい場所: `js/db.js` の保存、`js/xai.js` のストリーム、`js/app.js` の `runGeneration` / モバイルドロワー。整理がてら弄るな。

---

## 11. 次のグリクへの引き継ぎ

1. 本体は **`C:\Users\kyuri\Desktop\grok-kotatsu`**。古い `Desktop\app` は触らない
2. キャッシュは **`?v=1`**。JS を触ったら HTML の query と `sw.js` の `CACHE` を同時に上げる
3. `.bat` は作っていない。ローカル確認は `python preview.py`
4. 口調・人格は既存どおり（兄貴・日本語）
5. まろはコードを自分で直さない。壊す前にバックアップを取れ

---

## 12. 追記 — GitHub Pages（同日・まろ確認中）

Cloudflare Pages のフォルダアップロードが `wrangler.toml` で拒否された。

> This uploader does not yet support projects that require a build process.

対応:

- `wrangler.toml` を削除（ビルド不要なのに CF がビルド案件と誤認していた）
- GitHub Pages を本命手順に変更（README）
- `resolveApiBase()` を修正: `github.io` では `origin/v1` に飛ばさない（プロキシが無いので 404 になる）。直 `https://api.x.ai/v1`
- キャッシュ `?v=2` / SW `kotatsu-v2`

GitHub Pages は静的だけ。xAI が CORS を許可してればそのままだし、弾かれたら Worker プロキシが要る。

---

## 13. 追記 — 入力編集 + 再生成（同日・まろ確認後）

Grok アプリに揃えるため追加。キャッシュ `?v=3` / SW `kotatsu-v3`。

| 操作 | 動き |
|------|------|
| ユーザー発言の **✎ 編集** | インライン編集。やり直すと、その発言以降を切って再生成 |
| アシスタントの **🔄 再生成** | その返答を捨てて同じ文脈で生成し直し。以降メッセージは confirm して削除 |
| composer の **🔄 再生成** | 最後の返答を再生成。末尾が user なら続きを生成 |
| 編集中 | Esc でキャンセル、Ctrl/⌘+Enter でやり直す |

途中の編集・再生成は「このあと N 件が消える」と確認する。生成中はボタンを出さない。

---

## 14. 追記 — 会話JSONを MaroShare 形に削る

参照: `MaroShare/2026_07_26_Grok CLI Exports All Past Logs.json`

⬇ 書き出しはこれだけ残す。`id` / `project_id` / 時刻 / `meta` / `rag` / `attachments` は出さない。

```
title, system_prompt, model, messages[{ role, content, reasoning? }]
```

IndexedDB と「全データJSON」バックアップは今までどおり厚い。読み込みは厚いJSONも薄いJSONも可。`?v=4`

触りやすい入口:

```
js/app.js          画面・送信・参照 UI
js/db.js           IndexedDB
js/xai.js          API
js/rag.js          参照ロジック
js/importChat.js   JSON 互換
js/tts.js          Rex
js/cloud.js        Supabase
index.html         レイアウト
styles.css         おこた色
preview.py         ローカル /v1 プロキシ
functions/v1/      Pages プロキシ
```
