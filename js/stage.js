'use strict';
/* 出力画面：単色背景の上にキャラクターを描く。操作画面から BroadcastChannel で指示を受ける。 */
const PREVIEW = new URLSearchParams(location.search).has('preview');
const ROLE = PREVIEW ? 'preview' : 'stage';
const ID = Math.random().toString(36).slice(2);
const ch = new BroadcastChannel(CHANNEL);
const cv = document.getElementById('cv'), g = cv.getContext('2d'), hint = document.getElementById('hint');
const W = 1920, H = 1080;

let config = { bg: '#00ff00', chars: [] };     // chars: [{ id, x, y, scale, visible }]
const bitmaps = new Map();                     // imgKey -> ImageBitmap
const face = {};                               // charId -> { emotion, mouth }
const loadSeq = {};
let dirty = true;
const log = []; window.__stageLog = log;       // 動作確認用

function setFace(id, emotion, mouth) {
  const f = face[id] || (face[id] = { emotion: 'normal', mouth: 'closed' });
  if (emotion == null) emotion = f.emotion;
  if (f.emotion === emotion && f.mouth === mouth) return;
  f.emotion = emotion; f.mouth = mouth; dirty = true;
  if (log.length < 5000) log.push({ t: Date.now(), id, emotion, mouth });
}
function pick(id) {
  const f = face[id] || { emotion: 'normal', mouth: 'closed' };
  return bitmaps.get(imgKey(id, f.emotion, f.mouth)) || bitmaps.get(imgKey(id, f.emotion, 'closed'))
      || bitmaps.get(imgKey(id, 'normal', f.mouth)) || bitmaps.get(imgKey(id, 'normal', 'closed'));
}
async function loadChar(id) {
  const seq = loadSeq[id] = (loadSeq[id] || 0) + 1;
  const got = new Map();
  for (const e of EMOTIONS) for (const m of MOUTHS) {
    const k = imgKey(id, e.id, m.id);
    try { const b = await imgGet(k); if (b) got.set(k, await createImageBitmap(b)); } catch (err) { console.error(err); }
  }
  if (seq !== loadSeq[id]) return;
  for (const e of EMOTIONS) for (const m of MOUTHS) { const k = imgKey(id, e.id, m.id); const old = bitmaps.get(k); if (old && old !== got.get(k)) old.close(); bitmaps.delete(k); }
  for (const [k, v] of got) bitmaps.set(k, v);
  dirty = true;
}

function draw() {
  g.fillStyle = config.bg; g.fillRect(0, 0, W, H);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  let drawn = 0;
  for (const c of config.chars) {
    if (c.visible === false) continue;
    const bmp = pick(c.id); if (!bmp) continue;
    const s = c.scale ?? 1, h = H * s, w = h * bmp.width / bmp.height;
    g.drawImage(bmp, W / 2 + (c.x || 0) - w / 2, H - h - (c.y || 0), w, h);
    drawn++;
  }
  if (PREVIEW && !drawn) {
    g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(W / 2 - 700, H / 2 - 70, 1400, 140);
    g.fillStyle = '#fff'; g.font = '52px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('「キャラクター画像」に画像を登録してください', W / 2, H / 2);
  }
}
function tick() { if (dirty) { draw(); dirty = false; } requestAnimationFrame(tick); }

ch.onmessage = ev => {
  const m = ev.data; if (!m) return;
  switch (m.type) {
    case 'sync': {
      const before = new Set(config.chars.map(c => c.id));
      config = m.config; document.body.style.background = config.bg;
      for (const c of config.chars) {
        if (!face[c.id]) face[c.id] = { emotion: (m.faces && m.faces[c.id]) || 'normal', mouth: 'closed' };
        if (!before.has(c.id) || !loadSeq[c.id]) loadChar(c.id);
      }
      dirty = true; break;
    }
    case 'images': loadChar(m.charId); break;
    case 'face': setFace(m.charId, m.emotion, face[m.charId] ? face[m.charId].mouth : 'closed'); break;
    case 'mouth': setFace(m.charId, m.emotion, m.mouth); break;
    case 'stop': for (const id in face) setFace(id, null, 'closed'); break;
    case 'who': hello(); break;
  }
};
function hello() { ch.postMessage({ type: 'hello', role: ROLE, id: ID }); }

let hintTimer = 0;
function showHint() {
  if (PREVIEW) return;
  hint.textContent = 'ダブルクリックで全画面表示（Esc で解除）';
  hint.classList.remove('hide'); clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hint.classList.add('hide'), 8000);
}
function goFull() { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {}); }
if (!PREVIEW) {
  document.addEventListener('dblclick', goFull);
  document.addEventListener('keydown', e => { if (e.key === 'f' || e.key === 'F') goFull(); });
  document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) hint.classList.add('hide'); else showHint(); });
  let curTimer = 0;
  document.addEventListener('mousemove', () => {
    document.body.classList.remove('nocursor'); clearTimeout(curTimer);
    curTimer = setTimeout(() => document.body.classList.add('nocursor'), 2000);
  });
  showHint();
}
setInterval(() => ch.postMessage({ type: 'hb', role: ROLE, id: ID }), 1000);
requestAnimationFrame(tick);
hello();
