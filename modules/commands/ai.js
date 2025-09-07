// modules/commands/ai.js
const axios = require('axios');
const { createReadStream, unlinkSync, ensureDirSync, writeFileSync } = require('fs-extra');
const { resolve, join } = require('path');

module.exports.config = {
  name: 'ai',
  version: '2.4.0',
  hasPermssion: 0,
  credits: 'Nauth',
  description: 'Chat Gemini + auto hát/nói (TTS), trả lời dài hơn',
  commandCategory: 'Tiện ích',
  usages: 'ai <câu hỏi> | hoặc: ai hát/nói/đọc to ...',
  cooldowns: 1,
  images: []
};

/* ===================== CONFIG ===================== */
const GEMINI_KEY_FALLBACK = "AIzaSyCV4ch0M_7S1OO4oFPKsyBbO04uxbofVSM"; // key mới
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || GEMINI_KEY_FALLBACK;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || "gemini-1.5-flash-latest";
const GEMINI_BASE    = "https://generativelanguage.googleapis.com/v1beta";
const MAX_CHARS_TXT  = 4000;   // tăng để cắt đoạn dài hơn
const MAX_TTS_CHUNK  = 180;

// Persona: xưng cậu – tớ, trả lời chi tiết
const SYSTEM_PROMPT =
  'Bạn là Nauth. Xưng "cậu" với "tớ". Phong cách đáng yêu, thân thiện, tự nhiên. ' +
  'Hãy trả lời CHI TIẾT, mạch lạc, có ví dụ ngắn gọn và bước-lý-do rõ ràng. ' +
  'Mục tiêu: độ dài khoảng 6–10 câu (có thể hơn nếu cần), tránh lan man, không lặp lại. ' +
  'Nếu là code, ưu tiên JS/Node và kèm giải thích dùng thế nào.';

/* ===================== Helpers ===================== */
function chunkText(s, n = MAX_CHARS_TXT) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
function nowVN() {
  try { return new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }); }
  catch { return new Date().toISOString(); }
}

/* ===================== INTENT PARSER ===================== */
function parseFlags(input) {
  const raw = Array.isArray(input) ? input.join(' ') : String(input || '');
  const out = { prompt: '', tts: false, sing: false };

  const parts = raw.split(/\s+/).filter(Boolean);
  const rest = [];
  for (const a of parts) {
    if (/^--tts$/i.test(a)) out.tts = true;
    else if (/^--sing$/i.test(a)) out.sing = true;
    else rest.push(a);
  }
  out.prompt = rest.join(' ').trim();

  const r = raw.toLowerCase();
  const singKW = ['hát', 'hát đi', 'hát cho', 'hát bài', 'hát ru', 'sing', 'sing a song', 'hãy hát'];
  const ttsKW  = ['nói', 'đọc to', 'đọc giùm', 'đọc giúp', 'đọc lên', 'voice', 'speak', 'read aloud', 'đọc hộ', 'đọc thành tiếng'];

  if (!out.sing && singKW.some(k => r.includes(k))) out.sing = true;
  if (!out.tts  && ttsKW.some(k  => r.includes(k))) out.tts  = true;

  if (out.sing && out.tts) out.tts = false;
  if (!out.prompt.trim()) out.prompt = raw.trim();

  return out;
}

/* ===================== GEMINI ===================== */
function toGeminiContents(history, userText) {
  const fullUser = `${SYSTEM_PROMPT}\n\nNgười dùng: ${userText}`;
  const contents = [];
  for (const m of history || []) {
    if (m.role === 'user') contents.push({ role: 'user',  parts: [{ text: m.content }] });
    if (m.role === 'assistant') contents.push({ role: 'model', parts: [{ text: m.content }] });
  }
  contents.push({ role: 'user', parts: [{ text: fullUser }] });
  return contents;
}

async function askGemini({ history, userText, maxOutputTokens = 1024 }) {
  if (!GEMINI_API_KEY) throw new Error('Thiếu GEMINI_API_KEY');
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const payload = {
    contents: toGeminiContents(history, userText),
    generationConfig: { temperature: 0.65, topP: 0.9, maxOutputTokens }
  };
  const res = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 45000 });
  const data = res.data;
  const text =
    data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('')?.trim() ||
    data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  if (!text) throw new Error('Gemini không trả nội dung.');
  return text;
}

// Gọi nhiều lượt để câu trả lời dài hơn
async function askGeminiLong({ history = [], userText, parts = 3, tokensEach = 900 }) {
  let out = '';
  let hist = [...history];

  for (let i = 0; i < parts; i++) {
    const prompt = i === 0
      ? userText
      : 'Tiếp tục phần trả lời trước, không lặp lại. Nếu đã xong thì trả lời ngắn gọn: [HẾT].';

    const chunk = await askGemini({ history: hist, userText: prompt, maxOutputTokens: tokensEach });
    if (!chunk) break;

    if (/\[HẾT\]\s*$/i.test(chunk.trim())) {
      out += (out ? '\n' : '') + chunk.replace(/\[HẾT\]\s*$/i, '').trim();
      break;
    }

    out += (out ? '\n' : '') + chunk.trim();

    hist = [...hist,
      { role: 'user', content: prompt },
      { role: 'assistant', content: chunk }
    ];

    if (chunk.length < 200) break;
  }
  return out.trim() || (await askGemini({ history, userText, maxOutputTokens: tokensEach }));
}

/* ===================== TTS ===================== */
function splitForTTS(text) {
  const max = MAX_TTS_CHUNK;
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?…])\s+/);
  const chunks = [];
  for (const sent of sentences) {
    if (sent.length <= max) {
      chunks.push(sent);
      continue;
    }
    let buf = '';
    for (const w of sent.split(' ')) {
      if ((buf + ' ' + w).trim().length > max) {
        if (buf) chunks.push(buf.trim());
        buf = w;
      } else {
        buf = (buf ? buf + ' ' : '') + w;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }
  return chunks;
}

async function downloadTTSmp3(text, lang = "vi") {
  const url = "https://translate.google.com/translate_tts";
  const params = { ie: "UTF-8", q: text, tl: lang, client: "tw-ob" };
  const cacheDir = resolve(__dirname, "cache");
  ensureDirSync(cacheDir);
  const file = join(cacheDir, `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);

  const res = await axios.get(url, {
    params,
    responseType: "arraybuffer",
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  writeFileSync(file, Buffer.from(res.data));

  return file;
}

async function ttsFilesFromText(fullText, lang = "vi") {
  const segs = splitForTTS(fullText);
  const files = [];
  for (const s of segs) {
    const f = await downloadTTSmp3(s, lang);
    files.push(f);
  }
  return files;
}

/* ===================== SING ===================== */
async function makeLyrics(topic) {
  const prompt =
    `Viết lời bài hát tiếng Việt thật ngắn (4 dòng) về: "${topic}". ` +
    `Giữ giai điệu tươi vui, có vần và điệp ý dễ nhớ.`;
  return await askGemini({ history: [], userText: prompt });
}

/* ===================== COMMAND ===================== */
module.exports.run = async function ({ api, event, args }) {
  const parsed = parseFlags((args || []).join(' '));
  let q = parsed.prompt;

  if (!q) {
    return api.sendMessage(
      '⚠️ Dùng:\n' +
      '• Chat: ai <câu hỏi>\n' +
      '• Nói: ai nói/đọc to <nội dung>\n' +
      '• Hát: ai hát <chủ đề>',
      event.threadID,
      event.messageID
    );
  }

  try {
    if (parsed.sing) {
      if (!q.toLowerCase().startsWith('hát')) q = 'tình bạn dễ thương';
      const lyrics = await makeLyrics(q);
      const files = await ttsFilesFromText(lyrics, "vi");
      const cleanup = () => { for (const f of files) try { unlinkSync(f); } catch {} };

      return api.sendMessage(
        { body: `🎵 [LYRICS]\n${lyrics}\n\n⏰ ${nowVN()}`, attachment: files.map(f => createReadStream(f)) },
        event.threadID,
        (err, info) => {
          cleanup();
          if (err) return;
          global.client.handleReply.push({
            type: 'ai_chat',
            name: module.exports.config.name,
            messageID: info.messageID,
            history: [
              { role: 'user', content: q },
              { role: 'assistant', content: lyrics }
            ]
          });
        },
        event.messageID
      );
    }

    if (parsed.tts) {
      const answer = await askGeminiLong({ history: [], userText: q, parts: 3, tokensEach: 900 });
      const files = await ttsFilesFromText(answer, "vi");
      const cleanup = () => { for (const f of files) try { unlinkSync(f); } catch {} };

      return api.sendMessage(
        { body: `🔊 [ĐỌC TO]\n${answer}\n\n⏰ ${nowVN()}`, attachment: files.map(f => createReadStream(f)) },
        event.threadID,
        (err, info) => {
          cleanup();
          if (err) return;
          global.client.handleReply.push({
            type: 'ai_chat',
            name: module.exports.config.name,
            messageID: info.messageID,
            history: [
              { role: 'user', content: q },
              { role: 'assistant', content: answer }
            ]
          });
        },
        event.messageID
      );
    }

    // Chat thường (dùng trả lời dài)
    const answer = await askGeminiLong({ history: [], userText: q, parts: 3, tokensEach: 900 });
    const header = `[ GEMINI - AI ]\n────────────────────\n⏰ ${nowVN()}\n────────────────────\n`;
    const parts = chunkText(answer);

    api.sendMessage(
      header + parts[0],
      event.threadID,
      (err, info) => {
        if (err) return;
        global.client.handleReply.push({
          type: 'ai_chat',
          name: module.exports.config.name,
          messageID: info.messageID,
          history: [
            { role: 'user', content: q },
            { role: 'assistant', content: answer }
          ]
        });
        for (let i = 1; i < parts.length; i++) api.sendMessage(parts[i], event.threadID);
      },
      event.messageID
    );
  } catch (e) {
    api.sendMessage('❎ Lỗi AI/TTS: ' + (e?.response?.data?.error?.message || e?.message || e), event.threadID, event.messageID);
  }
};

/* ===================== handleReply ===================== */
module.exports.handleReply = async function ({ event, api, handleReply }) {
  const text = (event.body || '').trim();
  if (!text) return;

  const parsed = parseFlags(text);
  let q = parsed.prompt || text;

  try {
    if (parsed.sing) {
      if (!q.toLowerCase().startsWith('hát')) q = 'tình bạn dễ thương';
      const lyrics = await makeLyrics(q);
      const files = await ttsFilesFromText(lyrics, "vi");
      const cleanup = () => { for (const f of files) try { unlinkSync(f); } catch {} };
      let hist = handleReply.history || [];
      if (hist.length > 16) hist = hist.slice(-16);

      return api.sendMessage(
        { body: `🎵 [LYRICS]\n${lyrics}\n\n⏰ ${nowVN()}`, attachment: files.map(f => createReadStream(f)) },
        event.threadID,
        (err, info) => {
          cleanup();
          if (err) return;
          global.client.handleReply.push({
            ...handleReply,
            messageID: info.messageID,
            history: [...hist, { role: 'user', content: q }, { role: 'assistant', content: lyrics }]
          });
        },
        event.messageID
      );
    }

    if (parsed.tts) {
      let hist = handleReply.history || [];
      if (hist.length > 16) hist = hist.slice(-16);
      const answer = await askGeminiLong({ history: hist, userText: q, parts: 3, tokensEach: 900 });
      const files = await ttsFilesFromText(answer, "vi");
      const cleanup = () => { for (const f of files) try { unlinkSync(f); } catch {} };

      return api.sendMessage(
        { body: `🔊 [ĐỌC TO]\n${answer}\n\n⏰ ${nowVN()}`, attachment: files.map(f => createReadStream(f)) },
        event.threadID,
        (err, info) => {
          cleanup();
          if (err) return;
          global.client.handleReply.push({
            ...handleReply,
            messageID: info.messageID,
            history: [...hist, { role: 'user', content: q }, { role: 'assistant', content: answer }]
          });
        },
        event.messageID
      );
    }

    // Chat nối mạch (dùng trả lời dài)
    let hist = handleReply.history || [];
    if (hist.length > 16) hist = hist.slice(-16);

    const answer = await askGeminiLong({ history: hist, userText: q, parts: 3, tokensEach: 900 });
    const parts = chunkText(answer);

    api.sendMessage(
      parts[0],
      event.threadID,
      (err, info) => {
        if (err) return;
        global.client.handleReply.push({
          ...handleReply,
          messageID: info.messageID,
          history: [...hist, { role: 'user', content: q }, { role: 'assistant', content: answer }]
        });
        for (let i = 1; i < parts.length; i++) api.sendMessage(parts[i], event.threadID);
      },
      event.messageID
    );
  } catch (e) {
    api.sendMessage('❎ Lỗi AI/TTS: ' + (e?.response?.data?.error?.message || e?.message || e), event.threadID, event.messageID);
  }
};
