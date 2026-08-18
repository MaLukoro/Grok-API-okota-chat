/** Rex 優先の読み上げ。xAI TTS → 失敗時は端末の speechSynthesis。 */

import { stripForSpeech } from "./util.js";
import { ttsSpeak } from "./xai.js";

let currentAudio = null;
let speaking = false;
let stopFlag = false;

export function isSpeaking() {
  return speaking;
}

export function stopSpeak() {
  stopFlag = true;
  speaking = false;
  try {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.src = "";
      currentAudio = null;
    }
  } catch {
    /* ignore */
  }
  try {
    speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

function chunkText(text, max = 1800) {
  const s = stripForSpeech(text);
  if (s.length <= max) return s ? [s] : [];
  const parts = [];
  let rest = s;
  while (rest.length) {
    if (rest.length <= max) {
      parts.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("。", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.4) cut = max;
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  return parts.filter((p) => p.trim());
}

function playBlob(blob, speed) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.playbackRate = speed || 1;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("音声の再生に失敗した"));
    };
    audio.play().catch(reject);
  });
}

function speakBrowser(text, speed) {
  return new Promise((resolve, reject) => {
    if (!("speechSynthesis" in window)) {
      reject(new Error("この端末は読み上げ非対応"));
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const rex = voices.find((v) => /rex/i.test(v.name));
    const ja = voices.find((v) => /^ja/i.test(v.lang));
    u.voice = rex || ja || voices[0] || null;
    u.lang = (u.voice && u.voice.lang) || "ja-JP";
    u.rate = speed || 1;
    u.onend = resolve;
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

export async function speakText(settings, text, { onStart, onEnd } = {}) {
  stopSpeak();
  stopFlag = false;
  const chunks = chunkText(text);
  if (!chunks.length) return;
  speaking = true;
  if (onStart) onStart();
  try {
    for (const chunk of chunks) {
      if (stopFlag) break;
      try {
        const blob = await ttsSpeak(settings, {
          text: chunk,
          voiceId: settings.voiceId || "rex",
          language: settings.voiceLang || "ja",
        });
        if (stopFlag) break;
        await playBlob(blob, Number(settings.voiceSpeed) || 1);
      } catch (e) {
        console.warn("xAI TTS fallback", e);
        if (stopFlag) break;
        await speakBrowser(chunk, Number(settings.voiceSpeed) || 1);
      }
    }
  } finally {
    speaking = false;
    if (onEnd) onEnd();
  }
}
