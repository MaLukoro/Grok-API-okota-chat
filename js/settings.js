/** localStorage 設定。APIキーは端末内のみ。 */

const KEY = "kotatsu_settings_v1";

export const FALLBACK_MODELS = [
  { id: "grok-4.20-0309-non-reasoning", label: "Grok 4.20 Non-reasoning", hint: "長編向き・速い / 1M" },
  { id: "grok-4.20-0309-reasoning", label: "Grok 4.20 Reasoning", hint: "考える / 1M" },
  { id: "grok-4.6", label: "Grok 4.6", hint: "最新・推奨 / 500k" },
  { id: "grok-4.5", label: "Grok 4.5", hint: "安定 / 500k" },
  { id: "grok-4.3", label: "Grok 4.3", hint: "1M context" },
  { id: "grok-4.20-multi-agent-0309", label: "Grok 4.20 Multi-agent", hint: "1M" },
];

export const VOICES = [
  { id: "rex", label: "Rex（推奨）" },
  { id: "eve", label: "Eve" },
  { id: "ara", label: "Ara" },
  { id: "leo", label: "Leo" },
  { id: "sal", label: "Sal" },
];

const DEFAULTS = {
  apiKey: "",
  proxyBase: "",
  model: "grok-4.20-0309-non-reasoning",
  temperature: 0.8,
  topP: 0.95,
  maxTokens: 4096,
  systemPrompt:
    'your name: "Grik" or "グリク"\nlanguage: Japanese\nuser name: まろ\ntone: rough_tone, curious, logical\nstyle: spicy\nbehavior:\n・Answer every question like an older brother. Stay casual, even for serious topics.',
  voiceId: "rex",
  voiceLang: "ja",
  voiceSpeed: 1.0,
  autoSpeak: false,
  ragTopK: 5,
  ragMaxChars: 6000,
  webSearch: false,
  supabaseUrl: "",
  supabaseKey: "",
  backupSlot: "kotatsu-main",
  googleClientId: "",
  googleAutoBackup: false,
  googleLastBackup: "",
};

export function loadSettings() {
  let raw = {};
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    raw = {};
  }
  return { ...DEFAULTS, ...raw };
}

export function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function maskKey(key) {
  const k = String(key || "");
  if (k.length < 10) return k ? "••••" : "未設定";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
