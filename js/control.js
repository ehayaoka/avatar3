'use strict';
/* 操作画面：台本の編集、画像の登録、ブラウザ標準の音声での読み上げ、出力画面への指示。 */
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ch = new BroadcastChannel(CHANNEL);
const SS = window.speechSynthesis || null;
const LS_KEY = 'charatalk-web.project.v1';
const DEFAULT_VOICE = { uri: '', rate: 1, pitch: 1, volume: 1 };
const DEFAULT_LAYOUT = { x: 0, y: 0, scale: 1, visible: true };
const MAX_SIDE = 2160;                  // これより大きい画像は縮小して保存する
const EMO_IDS = EMOTIONS.map(e => e.id);

let project = null;
let activeChar = null;
let cursor = 0, playToken = 0, playingLineId = null;
let voices = [];
const faces = {};                       // charId -> 表情
const thumbs = new Map();               // imgKey -> objectURL
const dims = new Map();                 // imgKey -> { w, h, opaque }
let lastStageSeen = 0;

const uid = () => Math.random().toString(36).slice(2, 10);
const getChar = id => project.chars.find(c => c.id === id) || project.chars[0];
const newChar = (name, i = 0) => ({ id: uid(), name, ...DEFAULT_LAYOUT, x: i === 0 ? 0 : (i % 2 ? -480 : 480), voice: { ...DEFAULT_VOICE } });
const newLine = (char, emotion, text = '') => ({ id: uid(), char: char || project.chars[0].id, emotion: emotion || 'normal', text });

/* ---------- プロジェクト（台本＋設定） ---------- */
function defaultProject() {
  return { app: 'charatalk-web', version: 1, title: '台本1', settings: { bg: '#00ff00', gapSec: 0.4, lipSpeed: 1 }, chars: [newChar('キャラ1')], lines: [] };
}
function normalize(p) {
  const d = defaultProject();
  p = p && typeof p === 'object' ? p : {};
  const out = { app: 'charatalk-web', version: 1, title: typeof p.title === 'string' ? p.title : d.title,
    settings: { ...d.settings, ...(p.settings || {}) }, chars: [], lines: [] };
  for (const c of Array.isArray(p.chars) ? p.chars : []) {
    if (!c || !c.id) continue;
    out.chars.push({ ...DEFAULT_LAYOUT, ...c, name: String(c.name || 'キャラ'), voice: { ...DEFAULT_VOICE, ...(c.voice || {}) } });
  }
  if (!out.chars.length) out.chars = d.chars;
  for (const l of Array.isArray(p.lines) ? p.lines : []) {
    const c = out.chars.find(x => x.id === l.char) || out.chars[0];
    out.lines.push({ id: l.id || uid(), char: c.id, emotion: EMO_IDS.includes(l.emotion) ? l.emotion : 'normal', text: String(l.text ?? '') });
  }
  if (!out.lines.length) out.lines.push({ id: uid(), char: out.chars[0].id, emotion: 'normal', text: '' });
  return out;
}
let saveTimer = 0;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(project)); } catch (e) {} }, 300); }
function loadLocal() { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { return null; } }

/* ---------- 通知 ---------- */
let toastTimer = 0;
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.className = isErr ? 'err' : '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hide'), isErr ? 7000 : 3500);
}
const setProgress = s => { $('#progress').textContent = s; };

/* ---------- 出力画面との通信 ---------- */
function sendSync() {
  ch.postMessage({ type: 'sync', faces, config: { bg: project.settings.bg,
    chars: project.chars.map(c => ({ id: c.id, x: c.x, y: c.y, scale: c.scale, visible: c.visible })) } });
}
ch.onmessage = ev => {
  const m = ev.data; if (!m) return;
  if (m.role === 'stage' && (m.type === 'hb' || m.type === 'hello')) lastStageSeen = Date.now();
  if (m.type === 'hello') sendSync();
};
setInterval(() => {
  const ok = Date.now() - lastStageSeen < 2500, p = $('#stageStatus');
  p.textContent = ok ? '出力画面：接続中' : '出力画面：未接続'; p.className = 'pill ' + (ok ? 'ok' : 'ng');
}, 1000);

/* ---------- 声（Web Speech API） ---------- */
const isJa = v => /^ja\b|^ja[-_]/i.test(v.lang);
function refreshVoices() {
  voices = SS ? SS.getVoices() : [];
  const n = voices.filter(isJa).length, p = $('#voiceStatus');
  if (!SS) { p.textContent = '声：このブラウザは非対応'; p.className = 'pill ng'; }
  else if (n) { p.textContent = `声：日本語 ${n}種類`; p.className = 'pill ok'; }
  else if (voices.length) { p.textContent = '声：日本語の声がありません'; p.className = 'pill ng'; }
  else { p.textContent = '声：確認中'; p.className = 'pill wait'; }
  if (project) renderVoice();
}
function voiceFor(charId) {
  const want = getChar(charId).voice.uri;
  return voices.find(v => v.voiceURI === want) || voices.find(v => v.name === want)
      || voices.find(v => isJa(v) && v.localService) || voices.find(isJa) || null;
}
/* 長い文はブラウザによって途中で止まるため、文ごとに分けて読む */
function splitSentences(text) {
  const out = [];
  for (let s of text.replace(/\s*\n\s*/g, '。').split(/(?<=[。！？!?])/)) {
    s = s.trim(); if (!s || /^[。、！？!?\s]+$/.test(s)) continue;
    while (s.length > 80) { const k = s.lastIndexOf('、', 80); const cut = k > 20 ? k + 1 : 80; out.push(s.slice(0, cut)); s = s.slice(cut); }
    if (s) out.push(s);
  }
  return out;
}

/* ---------- 口ぱく ---------- */
// ブラウザの読み上げからは音の波形が取れないため、話している間は「開・閉」をリズムよく繰り返す。
// 単語の区切り（boundary）が通知される声では、その瞬間に口を開き直してリズムを合わせる。
const lip = { charId: null, emotion: 'normal', state: null, timer: 0, rate: 1 };
function sendMouth(m) {
  if (lip.state === m || !lip.charId) return;
  lip.state = m; ch.postMessage({ type: 'mouth', charId: lip.charId, emotion: lip.emotion, mouth: m });
}
function lipStep() {
  const mora = 150 / (lip.rate * (project.settings.lipSpeed || 1));        // 1拍の長さ（ms）
  let next;
  if (lip.state !== 'open') { sendMouth('open'); next = mora * (0.55 + Math.random() * 0.4); }
  else { sendMouth('closed'); next = mora * (Math.random() < 0.12 ? 0.9 : 0.3 + Math.random() * 0.25); }
  lip.timer = setTimeout(lipStep, next);
}
function lipStart() { clearTimeout(lip.timer); lip.state = null; lipStep(); }
function lipKick() { if (lip.state === 'open') return; clearTimeout(lip.timer); lipStep(); }
function lipStop() { clearTimeout(lip.timer); sendMouth('closed'); }

const keepAlive = new Set();           // 読み上げ中の発話が途中で消されないよう参照を持っておく
function speakChunk(text, charId, token) {
  return new Promise((resolve, reject) => {
    const v = getChar(charId).voice, vo = voiceFor(charId);
    const u = new SpeechSynthesisUtterance(text);
    if (vo) { u.voice = vo; u.lang = vo.lang; } else u.lang = 'ja-JP';
    u.rate = v.rate; u.pitch = v.pitch; u.volume = v.volume;
    keepAlive.add(u);
    let started = false, done = false, guard = 0;
    const finish = err => {
      if (done) return; done = true; clearTimeout(guard); keepAlive.delete(u);
      if (token === playToken) lipStop();
      err ? reject(err) : resolve();
    };
    u.onstart = () => {
      started = true; clearTimeout(guard);
      if (token !== playToken) return;
      lip.rate = v.rate; lipStart();
      guard = setTimeout(() => finish(), text.length * 400 / v.rate + 5000);   // 終了通知が来ないブラウザ対策
    };
    u.onboundary = () => { if (started && token === playToken) lipKick(); };
    u.onend = () => finish();
    u.onerror = e => (e.error === 'interrupted' || e.error === 'canceled') ? finish() : finish(new Error(`読み上げに失敗しました（${e.error}）`));
    guard = setTimeout(() => { if (!started) finish(new Error('読み上げが始まりません。声の選択を変えるか、ページを再読み込みしてください。')); }, 8000);
    if (SS.paused) SS.resume();
    SS.speak(u);
  });
}
async function speak(text, charId, emotion, token) {
  setFace(charId, emotion, false);
  lip.charId = charId; lip.emotion = emotion; lip.state = null;
  for (const s of splitSentences(text)) {
    await speakChunk(s, charId, token);
    if (token !== playToken) return false;
  }
  return true;
}
function cancelSpeech() { clearTimeout(lip.timer); if (SS && (SS.speaking || SS.pending)) SS.cancel(); }
function stopAll() { playToken++; cancelSpeech(); lip.state = null; ch.postMessage({ type: 'stop' }); setPlaying(null); setProgress(''); }

const nextSpeakable = from => { for (let i = Math.max(0, from); i < project.lines.length; i++) if (project.lines[i].text.trim()) return i; return -1; };
function checkVoice() {
  if (!SS) { toast('このブラウザは読み上げに対応していません。Chrome か Edge を使ってください。', true); return false; }
  if (!voices.length) refreshVoices();
  if (!voices.some(isJa)) toast('日本語の声が見つかりません。パソコンの設定で日本語の音声を追加してください。', true);
  return true;
}
async function playLine(idx, { auto = false, delay = 0 } = {}) {
  const token = ++playToken;
  cancelSpeech(); ch.postMessage({ type: 'stop' });
  const ln = project.lines[idx]; if (!ln || !checkVoice()) return;
  await sleep(60 + delay * 1000);                     // 停止直後すぐに話させると無視するブラウザがある
  if (token !== playToken) return;
  setPlaying(ln.id);
  const nx = nextSpeakable(idx + 1); setCursor(nx < 0 ? project.lines.length : nx);
  setProgress(auto ? '連続再生中…' : '');
  let ok = false;
  try { ok = await speak(ln.text.trim(), ln.char, ln.emotion, token); }
  catch (e) { if (token === playToken) { toast(e.message, true); setPlaying(null); setProgress(''); } return; }
  if (!ok || token !== playToken) return;
  setPlaying(null);
  if (!auto) return;
  const at = project.lines.findIndex(l => l.id === ln.id);
  const n = nextSpeakable((at < 0 ? idx : at) + 1);
  if (n >= 0) playLine(n, { auto: true, delay: project.settings.gapSec });
  else setProgress('');
}
function playNext() {
  const i = nextSpeakable(cursor);
  if (i < 0) { toast('台本の最後です。行番号をクリックすると再生位置を戻せます。'); return; }
  playLine(i);
}
function playAuto() {
  const i = nextSpeakable(cursor);
  if (i < 0) { toast('台本の最後です。行番号をクリックすると再生位置を戻せます。'); return; }
  playLine(i, { auto: true });
}
async function testVoice() {
  const token = ++playToken; cancelSpeech();
  if (!checkVoice()) return;
  await sleep(60); if (token !== playToken) return;
  try { await speak('こんにちは。声のテストです。', activeChar, faces[activeChar] || 'normal', token); }
  catch (e) { if (token === playToken) toast(e.message, true); }
}
function setFace(charId, emotion, render = true) {
  faces[charId] = emotion; if (render !== false || charId === activeChar) renderFaceButtons();
  ch.postMessage({ type: 'face', charId, emotion });
}

/* ---------- 画像 ---------- */
async function loadThumbs(charId) {
  for (const e of EMOTIONS) for (const m of MOUTHS) {
    const k = imgKey(charId, e.id, m.id);
    const b = await imgGet(k).catch(() => null);
    setThumb(k, b);
    if (b && !dims.has(k)) { try { dims.set(k, await measure(b)); } catch (err) {} }
  }
}
function setThumb(k, blob) {
  const old = thumbs.get(k); if (old) URL.revokeObjectURL(old);
  if (blob) thumbs.set(k, URL.createObjectURL(blob)); else { thumbs.delete(k); dims.delete(k); }
}
async function measure(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = 48; c.height = 48;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, 48, 48);
  const d = g.getImageData(0, 0, 48, 48).data; let opaque = true;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { opaque = false; break; }
  const r = { w: bmp.width, h: bmp.height, opaque }; bmp.close(); return r;
}
async function prepareImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch (e) { throw new Error(`「${file.name}」を画像として読み込めません。PNG形式で保存し直してください。`); }
  const sc = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  let blob = file;
  if (sc < 1 || !/^image\/(png|webp|jpeg)$/.test(file.type)) {
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise(r => c.toBlob(r, 'image/png'));
  }
  bmp.close();
  return blob;
}
let persistAsked = false;
async function storeImage(charId, emotion, mouth, file) {
  const k = imgKey(charId, emotion, mouth);
  const blob = await prepareImage(file);
  await imgPut(k, blob);
  setThumb(k, blob); dims.set(k, await measure(blob));
  if (!persistAsked && navigator.storage && navigator.storage.persist) { persistAsked = true; navigator.storage.persist().catch(() => {}); }
}
function imageWarnings(charId) {
  const list = [];
  for (const e of EMOTIONS) for (const m of MOUTHS) { const k = imgKey(charId, e.id, m.id), d = dims.get(k); if (d) list.push([k, d]); }
  const ref = dims.get(imgKey(charId, 'normal', 'closed')) || (list[0] && list[0][1]);
  const warn = new Map();
  for (const [k, d] of list) {
    const w = [];
    if (d.opaque) w.push('背景が透明ではありません');
    if (ref && (d.w !== ref.w || d.h !== ref.h) && Math.abs(d.w / d.h - ref.w / ref.h) > 0.01) w.push('ほかの画像と縦横の比率が違います');
    if (w.length) warn.set(k, w);
  }
  return warn;
}
async function afterImagesChanged(charId, msgs) {
  ch.postMessage({ type: 'images', charId });
  renderSlots(); renderLines();
  const warn = imageWarnings(charId);
  if (msgs && warn.size) {
    const kinds = new Set([...warn.values()].flat());
    if (kinds.has('背景が透明ではありません')) toast('背景が透明ではない画像があります。透明背景のPNGで書き出すと、背景色（緑など）だけが映ります。', true);
    else toast('縦横の比率が違う画像があります。10枚とも同じ大きさにすると、表情を変えたときに位置がずれません。', true);
  }
}
async function addFiles(files, charId, slot) {
  files = [...files]; if (!files.length) return;
  let ok = 0; const skipped = [];
  for (const f of files) {
    const s = slot && files.length === 1 ? slot : guessSlot(f.name);
    if (!s) { skipped.push(f.name); continue; }
    try { await storeImage(charId, s.emotion, s.mouth, f); ok++; }
    catch (e) { toast(e.message, true); }
  }
  await afterImagesChanged(charId, ok > 0);
  if (skipped.length) toast(`ファイル名から場所を判断できなかった画像があります：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' ほか' : ''}。枠に直接ドラッグしてください。`, true);
  else if (ok > 1) toast(`${ok}枚の画像を登録しました。`);
}
function renderSlots() {
  const box = $('#slots'); box.textContent = '';
  box.append(el('span'), el('span', 'hd', '口を閉じた'), el('span', 'hd', '口を開けた'));
  const warn = imageWarnings(activeChar); let n = 0;
  for (const e of EMOTIONS) {
    box.append(el('span', 'emo', e.label));
    for (const m of MOUTHS) {
      const k = imgKey(activeChar, e.id, m.id), url = thumbs.get(k);
      const s = el('div', 'slot' + (url ? ' has' : '')); s.title = `${e.label}（${m.label}）：クリックで選ぶ／ドラッグで登録`;
      s.dataset.emotion = e.id; s.dataset.mouth = m.id;
      if (url) {
        n++;
        const img = el('img'); img.src = url; img.alt = `${e.label}・${m.label}`; s.append(img);
        const del = el('button', 'del', '✕'); del.title = 'この画像を外す';
        del.onclick = async ev => { ev.stopPropagation(); await imgDel(k); setThumb(k, null); afterImagesChanged(activeChar); };
        s.append(del);
        if (warn.has(k)) { const w = el('span', 'warn', '⚠'); s.title = warn.get(k).join('／'); s.append(w); }
      } else s.append(el('span', 'empty', `${e.label}\n${m.label}`));
      s.onclick = () => { pendingSlot = { emotion: e.id, mouth: m.id }; $('#fileOne').click(); };
      s.ondragover = ev => { ev.preventDefault(); ev.stopPropagation(); s.classList.add('drag'); };
      s.ondragleave = () => s.classList.remove('drag');
      s.ondrop = ev => { ev.preventDefault(); ev.stopPropagation(); s.classList.remove('drag'); $('#imgCard').classList.remove('drag'); addFiles(ev.dataTransfer.files, activeChar, { emotion: e.id, mouth: m.id }); };
      box.append(s);
    }
  }
  $('#imgCount').textContent = `（${n}/10枚）`;
}
let pendingSlot = null;
async function loadSample() {
  const c = getChar(activeChar);
  const empty = !EMOTIONS.some(e => MOUTHS.some(m => thumbs.has(imgKey(c.id, e.id, m.id))));
  let target = c;
  if (!empty) { if (!confirm('サンプルのキャラクター（魔女）を新しく追加します。よろしいですか？')) return; target = addChar('魔女（サンプル）'); }
  else { c.name = '魔女（サンプル）'; }
  setProgress('サンプルを読み込み中…');
  try {
    for (const e of EMOTIONS) for (const m of MOUTHS) {
      const r = await fetch(`samples/majo/${e.id}_${m.id}.png`); if (!r.ok) throw new Error('サンプル画像が見つかりません');
      const b = await r.blob(); await imgPut(imgKey(target.id, e.id, m.id), b); setThumb(imgKey(target.id, e.id, m.id), b); dims.set(imgKey(target.id, e.id, m.id), await measure(b));
    }
  } catch (err) { toast(err.message, true); }
  setProgress(''); save(); renderChars(); afterImagesChanged(target.id); sendSync();
}

/* ---------- キャラクターの追加・削除・書き出し ---------- */
function addChar(name) {
  const c = newChar(name || `キャラ${project.chars.length + 1}`, project.chars.length);
  project.chars.push(c); faces[c.id] = 'normal'; activeChar = c.id; save(); renderChars(); renderSettings(); renderSlots(); renderLines(); sendSync();
  return c;
}
async function deleteChar() {
  if (project.chars.length <= 1) { toast('キャラクターは最低1人必要です。画像を入れ替えたいときは、枠の ✕ で外してください。', true); return; }
  const c = getChar(activeChar);
  if (!confirm(`「${c.name}」と、その画像10枚を削除します。よろしいですか？`)) return;
  for (const e of EMOTIONS) for (const m of MOUTHS) { const k = imgKey(c.id, e.id, m.id); await imgDel(k).catch(() => {}); setThumb(k, null); }
  project.chars = project.chars.filter(x => x.id !== c.id);
  activeChar = project.chars[0].id;
  for (const l of project.lines) if (l.char === c.id) l.char = activeChar;
  save(); renderChars(); renderSettings(); renderSlots(); renderLines(); sendSync();
}
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
async function exportChar() {
  const c = getChar(activeChar), images = {};
  for (const e of EMOTIONS) for (const m of MOUTHS) { const b = await imgGet(imgKey(c.id, e.id, m.id)); if (b) images[`${e.id}_${m.id}`] = await blobToDataURL(b); }
  if (!Object.keys(images).length) { toast('画像が登録されていません。', true); return; }
  const data = { app: 'charatalk-chara', version: 1, name: c.name, voice: c.voice, layout: { x: c.x, y: c.y, scale: c.scale }, images };
  download(JSON.stringify(data), (c.name.trim() || 'キャラクター') + '.chara.json');
}
async function importChar(file) {
  const data = JSON.parse(await file.text());
  if (!data || data.app !== 'charatalk-chara' || !data.images) throw new Error('キャラクターのファイルではありません。');
  const cur = getChar(activeChar);
  const empty = project.chars.length === 1 && !EMOTIONS.some(e => MOUTHS.some(m => thumbs.has(imgKey(cur.id, e.id, m.id))));
  const c = empty ? cur : addChar(data.name);
  c.name = String(data.name || c.name); Object.assign(c.voice, data.voice || {});
  if (data.layout) Object.assign(c, { x: +data.layout.x || 0, y: +data.layout.y || 0, scale: +data.layout.scale || 1 });
  for (const [name, url] of Object.entries(data.images)) {
    const [emotion, mouth] = name.split('_');
    if (!EMO_IDS.includes(emotion) || !MOUTHS.some(m => m.id === mouth)) continue;
    const b = await (await fetch(url)).blob(); const k = imgKey(c.id, emotion, mouth);
    await imgPut(k, b); setThumb(k, b); dims.set(k, await measure(b));
  }
  activeChar = c.id; save(); renderChars(); renderSettings(); afterImagesChanged(c.id); sendSync();
  toast(`「${c.name}」を読み込みました。`);
}
function download(text, name) {
  const a = el('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name.replace(/[\\/:*?"<>|]/g, '_'); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- 台本の表示 ---------- */
function setLineThumb(node, ln) {
  const url = thumbs.get(imgKey(ln.char, ln.emotion, 'closed')) || thumbs.get(imgKey(ln.char, 'normal', 'closed'));
  node.style.backgroundImage = url ? `url("${url}")` : '';
}
const autoGrow = ta => { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; };
function renderLines() {
  const box = $('#lines'); box.textContent = '';
  const multi = project.chars.length > 1;
  project.lines.forEach((ln, i) => {
    const row = el('div', 'line'); row.dataset.id = ln.id;
    const no = el('button', 'no', String(i + 1)); no.title = 'この行を次の再生位置にする';
    no.onclick = () => { setCursor(i); no.blur(); };
    const thumb = el('div', 'thumb'); setLineThumb(thumb, ln);
    const sels = el('div', 'sels');
    if (multi) {
      const sc = el('select'); sc.title = 'キャラクター';
      for (const c of project.chars) { const o = el('option', '', c.name); o.value = c.id; sc.append(o); }
      sc.value = ln.char;
      sc.onchange = () => { ln.char = sc.value; setLineThumb(thumb, ln); save(); sc.blur(); };
      sels.append(sc);
    }
    const se = el('select'); se.title = '表情';
    for (const e of EMOTIONS) { const o = el('option', '', e.label); o.value = e.id; se.append(o); }
    se.value = ln.emotion;
    se.onchange = () => { ln.emotion = se.value; setLineThumb(thumb, ln); save(); se.blur(); };
    sels.append(se);
    const ta = el('textarea'); ta.rows = 1; ta.value = ln.text; ta.placeholder = 'セリフを入力';
    ta.oninput = () => { ln.text = ta.value; autoGrow(ta); save(); };
    ta.onkeydown = e => {
      if (e.isComposing || e.keyCode === 229) return;            // 日本語変換中の Enter は無視
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); insertLine(i + 1, newLine(ln.char, ln.emotion)); focusLine(i + 1); }
      else if (e.key === 'Backspace' && ta.value === '' && project.lines.length > 1) { e.preventDefault(); removeLine(i); focusLine(Math.max(0, i - 1)); }
    };
    const acts = el('div', 'acts');
    const mk = (label, title, fn, cls) => { const b = el('button', cls, label); b.title = title; b.onclick = () => { fn(); b.blur(); }; acts.append(b); return b; };
    mk('▶', 'この行を再生', () => playLine(i), 'play');
    mk('↑', '上へ移動', () => moveLine(i, -1)).disabled = i === 0;
    mk('↓', '下へ移動', () => moveLine(i, 1)).disabled = i === project.lines.length - 1;
    mk('✕', 'この行を削除', () => removeLine(i)).disabled = project.lines.length <= 1;
    row.append(no, thumb, sels, ta, acts); box.append(row);
    autoGrow(ta);
  });
  cursor = Math.min(cursor, project.lines.length);
  refreshCursor(false); setPlaying(playingLineId);
}
const rowAt = i => $('#lines').children[i];
function focusLine(i) { const r = rowAt(i); if (r) { const ta = r.querySelector('textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
function insertLine(i, ln) { project.lines.splice(i, 0, ln); if (cursor >= i) cursor++; save(); renderLines(); }
function removeLine(i) { project.lines.splice(i, 1); if (cursor > i) cursor--; save(); renderLines(); }
function moveLine(i, d) { const j = i + d; if (j < 0 || j >= project.lines.length) return; const a = project.lines; [a[i], a[j]] = [a[j], a[i]]; save(); renderLines(); }
function setCursor(i) { cursor = Math.max(0, Math.min(project.lines.length, i)); refreshCursor(true); }
function refreshCursor(scroll) {
  [...$('#lines').children].forEach((r, i) => r.classList.toggle('cursor', i === cursor));
  const r = rowAt(cursor); if (scroll && r) r.scrollIntoView({ block: 'nearest' });
}
function setPlaying(lineId) { playingLineId = lineId; [...$('#lines').children].forEach(r => r.classList.toggle('playing', lineId != null && r.dataset.id === lineId)); }

/* ---------- 右側の設定 ---------- */
function bindRange(id, outId, get, set, fmt, after) {
  const r = $(id), o = $(outId);
  const show = () => { r.value = get(); o.textContent = fmt(Number(r.value)); };
  r.addEventListener('input', () => { set(Number(r.value)); o.textContent = fmt(Number(r.value)); if (after) after(); });
  r.addEventListener('change', () => { save(); r.blur(); });
  return show;
}
const shows = [];
function renderChars() {
  const sc = $('#selChar'); sc.textContent = '';
  for (const c of project.chars) { const o = el('option', '', c.name); o.value = c.id; sc.append(o); }
  sc.value = activeChar; $('#charName').value = getChar(activeChar).name;
}
function renderSettings() { shows.forEach(f => f()); renderBg(); renderVoice(); renderFaceButtons(); $('#chkVisible').checked = getChar(activeChar).visible; $('#title').value = project.title; }
function renderBg() { for (const b of $('#bgButtons').children) b.classList.toggle('on', b.dataset.bg === project.settings.bg); }
function renderFaceButtons() {
  const box = $('#faceButtons'); box.textContent = '';
  EMOTIONS.forEach((e, i) => {
    const b = el('button', faces[activeChar] === e.id ? 'on' : '', `${i + 1} ${e.label}`); b.title = `表情を「${e.label}」にする（キー ${i + 1}）`;
    b.onclick = () => { setFace(activeChar, e.id); b.blur(); }; box.append(b);
  });
}
function renderVoice() {
  const sel = $('#selVoice'), v = getChar(activeChar).voice; sel.textContent = '';
  const all = $('#chkAllVoices').checked;
  const list = voices.filter(x => all || isJa(x));
  const auto = voiceFor(activeChar);
  const o0 = el('option', '', auto ? `自動（${auto.name}）` : '自動'); o0.value = ''; sel.append(o0);
  for (const x of list) { const o = el('option', '', `${x.name}${all ? `［${x.lang}］` : ''}${x.localService ? '' : '（ネット）'}`); o.value = x.voiceURI; sel.append(o); }
  sel.value = list.some(x => x.voiceURI === v.uri) ? v.uri : '';
}
function bindSettings() {
  const C = () => getChar(activeChar), voice = () => C().voice, S = () => project.settings;
  const sgn = n => (n > 0 ? '+' : '') + n;
  shows.push(
    bindRange('#rngX', '#outX', () => C().x, v => { C().x = v; }, sgn, sendSync),
    bindRange('#rngY', '#outY', () => C().y, v => { C().y = v; }, sgn, sendSync),
    bindRange('#rngScale', '#outScale', () => C().scale, v => { C().scale = v; }, n => Math.round(n * 100) + '%', sendSync),
    bindRange('#rngRate', '#outRate', () => voice().rate, v => { voice().rate = v; }, n => n.toFixed(2)),
    bindRange('#rngPitch', '#outPitch', () => voice().pitch, v => { voice().pitch = v; }, n => n.toFixed(2)),
    bindRange('#rngVol', '#outVol', () => voice().volume, v => { voice().volume = v; }, n => Math.round(n * 100) + '%'),
    bindRange('#rngGap', '#outGap', () => S().gapSec, v => { S().gapSec = v; }, n => n.toFixed(1) + '秒'),
    bindRange('#rngLip', '#outLip', () => S().lipSpeed, v => { S().lipSpeed = v; }, n => '×' + n.toFixed(2)),
  );
  for (const b of $('#bgButtons').children) b.onclick = () => { S().bg = b.dataset.bg; renderBg(); sendSync(); save(); b.blur(); };
  $('#selChar').onchange = e => { activeChar = e.target.value; renderChars(); renderSettings(); renderSlots(); e.target.blur(); };
  $('#charName').oninput = e => { C().name = e.target.value; save(); };
  $('#charName').onchange = () => { renderChars(); renderLines(); };
  $('#btnAddChar').onclick = e => { addChar(); e.target.blur(); };
  $('#btnDelChar').onclick = e => { deleteChar(); e.target.blur(); };
  $('#chkVisible').onchange = e => { C().visible = e.target.checked; sendSync(); save(); e.target.blur(); };
  $('#btnResetLayout').onclick = e => { Object.assign(C(), { x: 0, y: 0, scale: 1 }); renderSettings(); sendSync(); save(); e.target.blur(); };
  $('#selVoice').onchange = e => { voice().uri = e.target.value; renderVoice(); save(); e.target.blur(); };
  $('#chkAllVoices').onchange = e => { renderVoice(); e.target.blur(); };
  $('#btnResetVoice').onclick = e => { Object.assign(voice(), { rate: 1, pitch: 1, volume: 1 }); renderSettings(); save(); e.target.blur(); };
  $('#btnTestVoice').onclick = e => { testVoice(); e.target.blur(); };
  $('#title').oninput = e => { project.title = e.target.value; save(); };

  // 画像
  $('#btnBulk').onclick = e => { $('#fileBulk').click(); e.target.blur(); };
  $('#fileBulk').onchange = e => { const f = [...e.target.files]; e.target.value = ''; addFiles(f, activeChar, null); };
  $('#fileOne').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (pendingSlot) addFiles(f, activeChar, pendingSlot); pendingSlot = null; };
  const card = $('#imgCard');
  card.ondragover = e => { e.preventDefault(); card.classList.add('drag'); };
  card.ondragleave = e => { if (!card.contains(e.relatedTarget)) card.classList.remove('drag'); };
  card.ondrop = e => { e.preventDefault(); card.classList.remove('drag'); addFiles(e.dataTransfer.files, activeChar, null); };
  $('#btnSample').onclick = e => { loadSample(); e.target.blur(); };
  $('#btnExport').onclick = e => { exportChar().catch(err => toast('書き出せませんでした：' + err.message, true)); e.target.blur(); };
  $('#btnImport').onclick = e => { $('#fileImport').click(); e.target.blur(); };
  $('#fileImport').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importChar(f).catch(err => toast('読み込めませんでした：' + err.message, true)); };

  $('#btnNext').onclick = e => { playNext(); e.target.blur(); };
  $('#btnAuto').onclick = e => { playAuto(); e.target.blur(); };
  $('#btnStop').onclick = e => { stopAll(); e.target.blur(); };
  $('#btnAdd').onclick = () => { const last = project.lines[project.lines.length - 1]; insertLine(project.lines.length, newLine(last && last.char, last && last.emotion)); focusLine(project.lines.length - 1); };
  $('#btnClear').onclick = e => { e.target.blur(); if (!confirm('台本のセリフをすべて削除します。よろしいですか？')) return; stopAll(); project.lines = [newLine()]; cursor = 0; save(); renderLines(); };
  $('#btnOpenStage').onclick = e => {
    e.target.blur();
    const w = window.open('stage.html', 'charatalk-stage', 'popup,width=1280,height=720');
    if (!w) toast('出力画面を開けませんでした。ブラウザのポップアップ許可を確認してください。', true);
    else toast('出力画面を ATEM 側のディスプレイへ移動し、ダブルクリックで全画面にしてください。');
  };
  $('#btnSave').onclick = e => { saveFile(); e.target.blur(); };
  $('#btnLoad').onclick = e => { $('#fileLoad').click(); e.target.blur(); };
  $('#fileLoad').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { openScript(JSON.parse(await f.text())); }
    catch (err) { toast('台本を開けませんでした：' + err.message, true); }
  };
  const dlg = $('#dlgPaste');
  $('#btnPaste').onclick = e => { e.target.blur(); $('#pasteText').value = ''; dlg.showModal(); };
  $('#btnPasteCancel').onclick = () => dlg.close();
  $('#btnPasteOk').onclick = () => {
    const add = parseBulk($('#pasteText').value); dlg.close(); if (!add.length) return;
    if (project.lines.length === 1 && !project.lines[0].text.trim()) project.lines = [];
    project.lines.push(...add); save(); renderLines(); toast(`${add.length}行を追加しました。`);
  };
}
/* 台本ファイルを開く：キャラクターは id → 名前の順で今のキャラクターと照合し、見つからなければ追加する */
function openScript(data) {
  if (!data || data.app !== 'charatalk-web' || !Array.isArray(data.lines)) throw new Error('このアプリの台本ファイルではありません。');
  stopAll();
  const map = new Map();
  for (const fc of Array.isArray(data.chars) ? data.chars : []) {
    let c = project.chars.find(x => x.id === fc.id) || project.chars.find(x => x.name === fc.name);
    if (!c) { c = { ...newChar(fc.name || 'キャラ'), ...fc, voice: { ...DEFAULT_VOICE, ...(fc.voice || {}) } }; project.chars.push(c); }
    else Object.assign(c, { x: fc.x ?? c.x, y: fc.y ?? c.y, scale: fc.scale ?? c.scale, visible: fc.visible ?? c.visible, voice: { ...c.voice, ...(fc.voice || {}) } });
    map.set(fc.id, c.id);
  }
  project.title = String(data.title || '台本');
  project.settings = { ...project.settings, ...(data.settings || {}) };
  project.lines = data.lines.map(l => ({ ...l, char: map.get(l.char) || l.char }));
  project = normalize(project);
  for (const c of project.chars) if (!faces[c.id]) faces[c.id] = 'normal';
  cursor = 0; save(); renderChars(); renderLines(); renderSettings(); renderSlots(); sendSync();
  Promise.all(project.chars.map(c => loadThumbs(c.id))).then(() => { renderLines(); renderSlots(); });
  toast(`「${project.title}」を開きました。`);
}
function parseBulk(text) {
  const map = new Map(); EMOTIONS.forEach(e => { map.set(e.label, e.id); map.set(e.id, e.id); });
  let charId = activeChar;
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => {
    const nm = s.match(/^([^\s：:［\[【]{1,20})\s*[：:]\s*(.*)$/);
    if (nm) { const c = project.chars.find(x => x.name === nm[1]); if (c) { charId = c.id; s = nm[2]; } }
    let emotion = 'normal';
    const m = s.match(/^[\[［【]\s*([^\]］】]+?)\s*[\]］】]\s*(.*)$/);
    if (m && map.has(m[1])) { emotion = map.get(m[1]); s = m[2]; }
    return newLine(charId, emotion, s);
  }).filter(l => l.text);
}
function saveFile() { download(JSON.stringify(project, null, 2), (project.title.trim() || '台本') + '.json'); }

/* ---------- キーボード ---------- */
document.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229 || !project) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); return; }
  if ($('#dlgPaste').open) return;
  const t = e.target, tag = t.tagName;
  const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox');
  if (typing) { if (e.key === 'Escape') t.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ') { e.preventDefault(); playNext(); }
  else if (e.key === 'Escape') stopAll();
  else if (tag === 'INPUT') return;
  else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(cursor + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(cursor - 1); }
  else if (/^[1-5]$/.test(e.key)) setFace(activeChar, EMOTIONS[Number(e.key) - 1].id);
});
document.addEventListener('keyup', e => { if (e.key === ' ' && e.target.tagName === 'BUTTON') e.preventDefault(); });
// ページの外にファイルを落としたときに、ブラウザが画像を開いてしまわないようにする
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

/* ---------- 起動 ---------- */
async function init() {
  if (location.protocol === 'file:') toast('ファイルを直接開くと、出力画面との連携が動かないことがあります。Webサーバー上のURLから開いてください。', true);
  project = normalize(loadLocal());
  activeChar = project.chars[0].id;
  for (const c of project.chars) faces[c.id] = 'normal';
  bindSettings(); renderChars(); renderSlots(); renderLines(); renderSettings();
  sendSync(); ch.postMessage({ type: 'who' });
  if (SS) { refreshVoices(); SS.addEventListener('voiceschanged', refreshVoices); setTimeout(refreshVoices, 1000); setTimeout(refreshVoices, 3000); }
  else refreshVoices();
  try { for (const c of project.chars) await loadThumbs(c.id); }
  catch (e) { toast('画像の保存領域を使えません（プライベートブラウズでは使えないことがあります）。', true); }
  renderSlots(); renderLines(); save();
}
init().catch(e => { console.error(e); toast('起動に失敗しました：' + e.message, true); });
