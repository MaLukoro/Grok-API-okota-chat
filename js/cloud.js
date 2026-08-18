/** Supabase への手動バックアップ / 復元。キーはユーザー自身のもの。 */

import { exportPack, importPack } from "./db.js";

function sbHeaders(settings) {
  const key = (settings.supabaseKey || "").trim();
  const url = (settings.supabaseUrl || "").trim().replace(/\/+$/, "");
  if (!url || !key) throw new Error("Supabase の URL と anon key を設定してくれ");
  return {
    url,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
  };
}

export function supabaseSql() {
  return `-- Supabase SQL Editor に貼る（1回だけ）
create table if not exists kotatsu_backups (
  id text primary key,
  kind text not null default 'pack',
  title text,
  payload jsonb not null,
  updated_at timestamptz default now()
);
alter table kotatsu_backups enable row level security;
drop policy if exists kotatsu_all on kotatsu_backups;
create policy kotatsu_all on kotatsu_backups
  for all using (true) with check (true);
-- 個人用。anon key は人に配らないこと。`;
}

export async function uploadBackup(settings) {
  const { url, headers } = sbHeaders(settings);
  const pack = await exportPack();
  const slot = (settings.backupSlot || "kotatsu-main").trim() || "kotatsu-main";
  const row = {
    id: slot,
    kind: "pack",
    title: `Grok Kotatsu ${new Date().toLocaleString("ja-JP")}`,
    payload: pack,
    updated_at: new Date().toISOString(),
  };
  const res = await fetch(`${url}/rest/v1/kotatsu_backups`, {
    method: "POST",
    headers,
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`アップロード失敗: ${res.status} ${t}`);
  }
  return { slot, chats: pack.chats.length, projects: pack.projects.length, files: pack.files.length };
}

export async function downloadBackup(settings, { merge = true } = {}) {
  const { url, headers } = sbHeaders(settings);
  const slot = (settings.backupSlot || "kotatsu-main").trim() || "kotatsu-main";
  const res = await fetch(
    `${url}/rest/v1/kotatsu_backups?id=eq.${encodeURIComponent(slot)}&select=payload,updated_at,title`,
    { headers: { ...headers, Prefer: "return=representation" } }
  );
  if (!res.ok) throw new Error(`ダウンロード失敗: ${res.status}`);
  const rows = await res.json();
  if (!rows.length) throw new Error(`スロット「${slot}」にバックアップが無いよ`);
  const pack = rows[0].payload;
  const stats = await importPack(pack, { merge });
  return { ...stats, updated_at: rows[0].updated_at, title: rows[0].title };
}
