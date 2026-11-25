import { loadSource, decodeAudio } from "./lib/media.js";
import { drawFrame, orientedSize, maxSquare } from "./lib/render.js";
import { createSticker, estimate, STICKER_LIMIT } from "./lib/pipeline.js";
import { library } from "./lib/db.js";
import { calibrationSource, calibrationAudio } from "./lib/calibration.js";
import { bytesToB64, formatBytes, formatTime, clamp } from "./lib/util.js";

const $ = (id) => document.getElementById(id);
const hasExt = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);
const MIN_CROP = 16;

const st = {
  src: null,
  rot: 0, flipH: false, flipV: false,
  mode: "square",
  crop: null,
  start: 0, end: 0,
  audioKind: "video", audioFile: null, audioUrl: null, audioDur: 0, audioStart: 0, audioEnd: 0,
  gain: 1, fps: 15, size: 512, syncMs: 0,
  busy: false, connected: false, result: null,
};
const tf = () => ({ rot: st.rot, flipH: st.flipH, flipV: st.flipV });
const oriented = () => orientedSize(st.src.w, st.src.h, st.rot);
const isVideo = () => st.src && st.src.kind === "video";

// ================================================================ preferencias
const PREFS_KEY = "yapper:prefs";
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || localStorage.getItem("sonistick:prefs") || "{}"); } catch (e) { return {}; }
})();
const icon = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;
function savePrefs() {
  const p = {
    fps: st.fps, size: st.size, pack: $("pack").value, author: $("author").value, emoji: $("emoji").value,
    dest: $("dest").value, openForward: $("openForward").checked, syncMs: st.syncMs,
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* sin almacenamiento */ }
}
if (prefs.fps) { st.fps = prefs.fps; $("fps").value = String(prefs.fps); }
if (prefs.size) { st.size = prefs.size; $("size").value = String(prefs.size); }
if (prefs.pack) $("pack").value = prefs.pack;
if (prefs.author) $("author").value = prefs.author;
if (prefs.emoji) $("emoji").value = prefs.emoji;
$("openForward").checked = !!prefs.openForward;
setSync(prefs.syncMs || 0, false);

function setSync(ms, save = true) {
  st.syncMs = clamp(Math.round(ms / 10) * 10, -1000, 1000);
  $("sync").value = String(st.syncMs);
  $("syncVal").textContent = (st.syncMs > 0 ? "+" : "") + st.syncMs + " ms";
  if (save) savePrefs();
}
$("sync").addEventListener("input", () => setSync(+$("sync").value));
$("btnCalibApply").addEventListener("click", () => {
  const seen = parseFloat(String($("calibSeen").value).replace("−", "-"));
  if (!Number.isFinite(seen)) return toast("Escribe el número que viste al oír el pitido");
  setSync(st.syncMs + seen);
  $("calibSeen").value = "";
  toast(`Compensación: ${st.syncMs > 0 ? "+" : ""}${st.syncMs} ms. Crea otro sticker de calibración para comprobar.`, "ok");
});
$("btnCalib").addEventListener("click", async () => {
  if (st.busy) return;
  pause();
  $("settings").close();
  setBusy(true);
  try {
    const res = await createSticker({
      source: calibrationSource(), start: 0, end: 3, fps: 30, size: 512,
      tf: { rot: 0, flipH: false, flipV: false }, crop: null, syncMs: st.syncMs,
      audio: calibrationAudio(), meta: { pack: "Calibración", author: "Yapper", emojis: ["⏱️"] },
      onProgress: showProgress,
    });
    const rec = await library.add({ name: `calibracion_${st.syncMs}ms`, webp: res.webp, ogg: res.ogg, info: res.info });
    st.result = rec;
    showResult(rec);
    renderLibrary();
    if (st.connected) await send(rec);
    else { hideProgress(); toast("Sticker de calibración guardado en la biblioteca (WhatsApp Web no está conectado)."); }
  } catch (e) {
    hideProgress();
    toast(e.message, "err");
  } finally {
    setBusy(false);
  }
});

// ================================================================ avisos
let toastTimer = null;
function toast(text, kind = "") {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "err" ? 7000 : 3500);
}

// ================================================================ carga de archivos
async function openFile(file) {
  if (!file || st.busy) return;
  let src;
  try {
    src = await loadSource(file);
  } catch (e) {
    return toast(e.message, "err");
  }
  disposeSource();
  st.src = src;
  st.rot = 0; st.flipH = false; st.flipV = false;
  st.mode = "square";
  setSeg("[data-mode]", "mode", "square");
  hideResult();

  if (isVideo()) {
    st.start = 0;
    st.end = Math.min(src.duration, 8);
    src.el.addEventListener("ended", () => updatePlayButton());
    if (st.audioKind !== "file") setAudioKind("video");
  } else {
    setAudioKind("file");
  }
  $("transport").hidden = !isVideo();
  document.querySelector('[data-audio="video"]').disabled = !isVideo();

  $("drop").hidden = true;
  $("editor").hidden = false;
  $("panels").hidden = false;
  $("noFile").hidden = true;
  $("btnNewFile").hidden = false;
  showTab("edit");
  refreshSendButtons();
  resetCrop();
  layoutStage();
  updateTimeline();
  scheduleEstimate();
}

function disposeSource() {
  if (!st.src) return;
  if (st.src.el) { st.src.el.pause(); st.src.el.removeAttribute("src"); st.src.el.load(); }
  if (st.src.bitmap) st.src.bitmap.close();
  URL.revokeObjectURL(st.src.url);
  st.src = null;
}

$("fileInput").addEventListener("change", (e) => { openFile(e.target.files[0]); e.target.value = ""; });
$("btnNewFile").addEventListener("click", () => $("fileInput").click());
window.addEventListener("dragover", (e) => { e.preventDefault(); $("drop").classList.add("over"); });
window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("drop").classList.remove("over"); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  $("drop").classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (st.src && f.type.startsWith("audio/")) return pickAudio(f);
  openFile(f);
});
window.addEventListener("paste", (e) => {
  const f = e.clipboardData && e.clipboardData.files[0];
  if (f) openFile(f);
});

// ================================================================ escenario y recorte
const stage = $("stage");
const sctx = stage.getContext("2d");
const pctx = $("preview").getContext("2d");
const box = $("stageBox");
const cropEl = $("cropRect");

function layoutStage() {
  if (!st.src) return;
  const [OW, OH] = oriented();
  const wrap = $("stageWrap");
  const W = wrap.clientWidth - 24;
  const H = wrap.clientHeight - 24;
  const s = Math.max(0.01, Math.min(W / OW, H / OH));
  box.style.width = Math.floor(OW * s) + "px";
  box.style.height = Math.floor(OH * s) + "px";
  const k = Math.min(1, 1280 / Math.max(OW, OH));
  stage.width = Math.max(1, Math.round(OW * k));
  stage.height = Math.max(1, Math.round(OH * k));
  positionCrop();
}
new ResizeObserver(layoutStage).observe($("stageWrap"));

function resetCrop() {
  const [OW, OH] = oriented();
  st.crop = st.mode === "square" ? maxSquare(OW, OH) : { x: 0, y: 0, w: OW, h: OH };
  positionCrop();
}

function positionCrop() {
  if (!st.src || !st.crop) return;
  const [OW, OH] = oriented();
  const c = st.crop;
  cropEl.style.left = (c.x / OW) * 100 + "%";
  cropEl.style.top = (c.y / OH) * 100 + "%";
  cropEl.style.width = (c.w / OW) * 100 + "%";
  cropEl.style.height = (c.h / OH) * 100 + "%";
  cropEl.classList.toggle("square", st.mode === "square");
  const pct = Math.round(((c.w * c.h) / (OW * OH)) * 100);
  $("cropInfo").textContent = `${Math.round(c.w)}×${Math.round(c.h)} px · ${pct} % del cuadro`;
}

function cropChanged() {
  positionCrop();
  scheduleEstimate();
}

function toOriented(e) {
  const r = box.getBoundingClientRect();
  const [OW, OH] = oriented();
  return { x: ((e.clientX - r.left) / r.width) * OW, y: ((e.clientY - r.top) / r.height) * OH };
}

let drag = null;
cropEl.addEventListener("pointerdown", (e) => {
  if (!st.src) return;
  e.preventDefault();
  cropEl.setPointerCapture(e.pointerId);
  drag = { handle: e.target.dataset.h || "move", p0: toOriented(e), c0: { ...st.crop } };
});
cropEl.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const [OW, OH] = oriented();
  const p = toOriented(e);
  const dx = p.x - drag.p0.x;
  const dy = p.y - drag.p0.y;
  const c0 = drag.c0;
  const h = drag.handle;

  if (h === "move") {
    st.crop = { ...c0, x: clamp(c0.x + dx, 0, OW - c0.w), y: clamp(c0.y + dy, 0, OH - c0.h) };
  } else if (st.mode === "square") {
    // la esquina opuesta queda fija
    const ax = h.includes("w") ? c0.x + c0.w : c0.x;
    const ay = h.includes("n") ? c0.y + c0.h : c0.y;
    const maxSide = Math.min(h.includes("w") ? ax : OW - ax, h.includes("n") ? ay : OH - ay);
    const side = clamp(Math.max(Math.abs(p.x - ax), Math.abs(p.y - ay)), MIN_CROP, maxSide);
    st.crop = { x: h.includes("w") ? ax - side : ax, y: h.includes("n") ? ay - side : ay, w: side, h: side };
  } else {
    let L = c0.x, T = c0.y, R = c0.x + c0.w, B = c0.y + c0.h;
    if (h.includes("w")) L = clamp(L + dx, 0, R - MIN_CROP);
    if (h.includes("e")) R = clamp(R + dx, L + MIN_CROP, OW);
    if (h.includes("n")) T = clamp(T + dy, 0, B - MIN_CROP);
    if (h.includes("s")) B = clamp(B + dy, T + MIN_CROP, OH);
    st.crop = { x: L, y: T, w: R - L, h: B - T };
  }
  positionCrop();
});
const endDrag = () => { if (drag) { drag = null; cropChanged(); } };
cropEl.addEventListener("pointerup", endDrag);
cropEl.addEventListener("pointercancel", endDrag);

box.addEventListener("wheel", (e) => {
  if (!st.src) return;
  e.preventDefault();
  const [OW, OH] = oriented();
  const c = st.crop;
  let f = e.deltaY > 0 ? 1.06 : 1 / 1.06;
  f = Math.min(f, OW / c.w, OH / c.h);
  f = Math.max(f, MIN_CROP / c.w, MIN_CROP / c.h);
  const w = c.w * f;
  const h = c.h * f;
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  st.crop = { x: clamp(cx - w / 2, 0, OW - w), y: clamp(cy - h / 2, 0, OH - h), w, h };
  positionCrop();
  scheduleEstimate();
}, { passive: false });

function setSeg(selector, key, value) {
  document.querySelectorAll(selector).forEach((b) => b.classList.toggle("on", b.dataset[key] === value));
}

document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
  if (!st.src) return;
  st.mode = b.dataset.mode;
  setSeg("[data-mode]", "mode", st.mode);
  if (st.mode === "square") {
    const [OW, OH] = oriented();
    const c = st.crop;
    const side = Math.min(c.w, c.h);
    st.crop = { x: clamp(c.x + (c.w - side) / 2, 0, OW - side), y: clamp(c.y + (c.h - side) / 2, 0, OH - side), w: side, h: side };
  }
  cropChanged();
}));

function rotate(delta) {
  st.rot = (st.rot + delta + 360) % 360;
  resetCrop();
  layoutStage();
  scheduleEstimate();
}
$("btnRotL").addEventListener("click", () => rotate(-90));
$("btnRotR").addEventListener("click", () => rotate(90));
$("btnFlipH").addEventListener("click", () => {
  const [OW] = oriented();
  st.flipH = !st.flipH;
  st.crop = { ...st.crop, x: OW - st.crop.x - st.crop.w };
  cropChanged();
});
$("btnFlipV").addEventListener("click", () => {
  const [, OH] = oriented();
  st.flipV = !st.flipV;
  st.crop = { ...st.crop, y: OH - st.crop.y - st.crop.h };
  cropChanged();
});
$("btnFit").addEventListener("click", () => { resetCrop(); scheduleEstimate(); });
$("btnFull").addEventListener("click", () => {
  st.mode = "free";
  setSeg("[data-mode]", "mode", "free");
  resetCrop();
  scheduleEstimate();
});

// ================================================================ dibujo continuo
function currentImage() {
  return isVideo() ? st.src.el : st.src.bitmap;
}
function frame() {
  requestAnimationFrame(frame);
  if (!st.src) return;
  const v = isVideo() ? st.src.el : null;
  if (v && !v.paused && vt() >= st.end) {
    seek(st.start);
    syncAudio();
  }
  if (v && v.readyState < 2) return;
  const img = currentImage();
  drawFrame(sctx, img, st.src.w, st.src.h, tf(), null, stage.width, stage.height);
  drawFrame(pctx, img, st.src.w, st.src.h, tf(), st.crop, 256, 256);
  if (v) {
    $("tlHead").style.left = (clamp(vt(), 0, st.src.duration) / st.src.duration) * 100 + "%";
    $("timeNow").textContent = formatTime(Math.max(0, vt()));
  }
}
requestAnimationFrame(frame);

// ================================================================ línea de tiempo y reproducción
const sfx = $("sfx");

function updateTimeline() {
  if (!isVideo()) return;
  const d = st.src.duration;
  const a = (st.start / d) * 100;
  const b = (st.end / d) * 100;
  $("tlRange").style.left = a + "%";
  $("tlRange").style.width = b - a + "%";
  $("tlStart").style.left = a + "%";
  $("tlEnd").style.left = b + "%";
  $("segInfo").textContent = `${formatTime(st.start)} – ${formatTime(st.end)} · ${(st.end - st.start).toFixed(2)} s`;
}

// Tiempo relativo al primer cuadro (ver `offset` en media.js).
function vt() { return st.src.el.currentTime - (st.src.offset || 0); }
function seek(t) {
  st.src.el.currentTime = (st.src.offset || 0) + clamp(t, 0, Math.max(0, st.src.duration - 0.001));
}

let tlDrag = null;
$("timeline").addEventListener("pointerdown", (e) => {
  if (!isVideo()) return;
  e.preventDefault();
  $("timeline").setPointerCapture(e.pointerId);
  tlDrag = e.target.id === "tlStart" ? "start" : e.target.id === "tlEnd" ? "end" : "head";
  pause();
  tlMove(e);
});
$("timeline").addEventListener("pointermove", (e) => { if (tlDrag) tlMove(e); });
const tlUp = () => { if (tlDrag && tlDrag !== "head") scheduleEstimate(); tlDrag = null; };
$("timeline").addEventListener("pointerup", tlUp);
$("timeline").addEventListener("pointercancel", tlUp);

function tlMove(e) {
  const r = $("timeline").getBoundingClientRect();
  const t = clamp(((e.clientX - r.left) / r.width) * st.src.duration, 0, st.src.duration);
  if (tlDrag === "start") { st.start = Math.min(t, st.end - 0.1); seek(st.start); }
  else if (tlDrag === "end") { st.end = Math.max(t, st.start + 0.1); seek(st.end - 0.02); }
  else seek(t);
  updateTimeline();
}

function setIn() { st.start = clamp(vt(), 0, st.end - 0.1); updateTimeline(); scheduleEstimate(); }
function setOut() { st.end = clamp(vt(), st.start + 0.1, st.src.duration); updateTimeline(); scheduleEstimate(); }
$("btnIn").addEventListener("click", setIn);
$("btnOut").addEventListener("click", setOut);

function step(dir) {
  pause();
  seek(vt() + dir / 30);
}
$("btnPrev").addEventListener("click", () => step(-1));
$("btnNext").addEventListener("click", () => step(1));

function syncAudio() {
  const v = st.src.el;
  if (st.audioKind === "file" && st.audioUrl) {
    sfx.currentTime = st.audioStart + (vt() - st.start);
    if (!v.paused) sfx.play().catch(() => {});
  }
}
function play() {
  const v = st.src.el;
  if (vt() < st.start || vt() >= st.end - 0.03) seek(st.start);
  v.muted = st.audioKind === "file";
  v.volume = Math.min(1, st.gain);
  v.play().then(syncAudio).catch(() => {});
  updatePlayButton(true);
}
function pause() {
  if (!isVideo()) return;
  st.src.el.pause();
  sfx.pause();
  updatePlayButton(false);
}
function updatePlayButton(playing = isVideo() && !st.src.el.paused) {
  $("btnPlay").innerHTML = icon(playing ? "pause" : "play");
}
$("btnPlay").addEventListener("click", () => (st.src.el.paused ? play() : pause()));

window.addEventListener("keydown", (e) => {
  if (!isVideo() || e.target.closest("input, select, textarea")) return;
  if (e.code === "Space") { e.preventDefault(); st.src.el.paused ? play() : pause(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  else if (e.key === "i" || e.key === "I") setIn();
  else if (e.key === "o" || e.key === "O") setOut();
});

// ================================================================ audio
function setAudioKind(kind) {
  st.audioKind = kind;
  setSeg("[data-audio]", "audio", kind);
  $("audioFileBox").hidden = kind !== "file";
  $("audioEndField").hidden = isVideo();
  pause();
  updateAudioInfo();
}
document.querySelectorAll("[data-audio]").forEach((b) => b.addEventListener("click", () => setAudioKind(b.dataset.audio)));
$("audioInput").addEventListener("change", (e) => { pickAudio(e.target.files[0]); e.target.value = ""; });

async function pickAudio(file) {
  if (!file) return;
  try {
    const buf = await decodeAudio(file);
    if (st.audioUrl) URL.revokeObjectURL(st.audioUrl);
    st.audioFile = file;
    st.audioUrl = URL.createObjectURL(file);
    sfx.src = st.audioUrl;
    st.audioDur = buf.duration;
    st.audioStart = 0;
    st.audioEnd = Math.min(buf.duration, 10);
    $("audioStart").value = "0";
    $("audioEnd").value = st.audioEnd.toFixed(2);
    $("audioName").textContent = "🎵 " + file.name;
    setAudioKind("file");
    if (!isVideo()) scheduleEstimate();
  } catch (e) {
    toast(e.message, "err");
  }
}
$("audioStart").addEventListener("change", () => {
  st.audioStart = clamp(parseFloat($("audioStart").value) || 0, 0, Math.max(0, st.audioDur - 0.1));
  $("audioStart").value = st.audioStart.toFixed(2);
  if (st.audioEnd <= st.audioStart) { st.audioEnd = Math.min(st.audioDur, st.audioStart + 5); $("audioEnd").value = st.audioEnd.toFixed(2); }
  updateAudioInfo();
});
$("audioEnd").addEventListener("change", () => {
  st.audioEnd = clamp(parseFloat($("audioEnd").value) || 0, st.audioStart + 0.1, st.audioDur);
  $("audioEnd").value = st.audioEnd.toFixed(2);
  updateAudioInfo();
});
function updateAudioInfo() {
  if (!st.audioFile) { $("audioLen").textContent = ""; return; }
  $("audioLen").textContent = isVideo()
    ? `Se usa desde ${st.audioStart.toFixed(2)} s, durante lo mismo que el tramo del video.`
    : `Duración del sticker: ${(st.audioEnd - st.audioStart).toFixed(2)} s (de ${st.audioDur.toFixed(2)} s).`;
}
$("gain").addEventListener("input", () => {
  st.gain = $("gain").value / 100;
  $("gainVal").textContent = $("gain").value + " %";
  if (isVideo()) st.src.el.volume = Math.min(1, st.gain);
  sfx.volume = Math.min(1, st.gain);
});

// ================================================================ salida y estimación
$("fps").addEventListener("change", () => { st.fps = +$("fps").value; savePrefs(); scheduleEstimate(); });
$("size").addEventListener("change", () => { st.size = +$("size").value; savePrefs(); scheduleEstimate(); });
["pack", "author", "emoji", "openForward", "dest"].forEach((id) => $(id).addEventListener("change", savePrefs));

let estTimer = null;
let estToken = 0;
function scheduleEstimate() {
  clearTimeout(estTimer);
  $("estimate").textContent = "Calculando peso…";
  estTimer = setTimeout(runEstimate, 500);
}
async function runEstimate() {
  if (!st.src) return;
  if (st.busy) { estTimer = setTimeout(runEstimate, 800); return; }
  const token = ++estToken;
  try {
    const plan = { start: st.start, end: st.end, fps: st.fps, size: st.size, tf: tf(), crop: st.crop };
    const r = await estimate(st.src, plan);
    if (token !== estToken) return;
    const ratio = r.bytes / STICKER_LIMIT;
    const bar = $("meterBar");
    bar.style.width = Math.min(100, ratio * 100) + "%";
    let msg;
    if (ratio <= 1) { bar.style.background = "var(--ok)"; msg = "cabe"; }
    else if (ratio <= 2.5) { bar.style.background = "var(--warn)"; msg = "se bajará la calidad para que quepa"; }
    else { bar.style.background = "var(--bad)"; msg = "difícil que quepa: acorta el tramo o baja fps / resolución"; }
    $("estimate").textContent = `≈ ${formatBytes(r.bytes)} de 1 MB · ${r.frames} cuadro${r.frames === 1 ? "" : "s"} · ${msg}`;
  } catch (e) {
    if (token === estToken) $("estimate").textContent = "No se pudo estimar: " + e.message;
  }
}

// ================================================================ crear y enviar
function setBusy(b) {
  st.busy = b;
  ["btnNewFile", "btnCalib"].forEach((id) => ($(id).disabled = b));
  refreshSendButtons();
}
function refreshSendButtons() {
  const can = st.connected && !st.busy;
  $("btnCreate").disabled = st.busy || !st.src;
  $("btnCreateSend").disabled = !can || !st.src;
  $("btnCreateSend").title = st.connected ? "" : "Abre WhatsApp Web para enviar";
  $("btnResultSend").disabled = !can;
  document.querySelectorAll(".lib-send").forEach((b) => (b.disabled = !can));
}

// ================================================================ pestañas y ajustes
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
  $("tabEdit").hidden = name !== "edit";
  $("tabLib").hidden = name !== "lib";
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
$("btnSettings").addEventListener("click", () => $("settings").showModal());
$("btnSettingsClose").addEventListener("click", () => $("settings").close());
$("settings").addEventListener("click", (e) => { if (e.target === $("settings")) $("settings").close(); });
function showProgress(text, frac) {
  $("progress").hidden = false;
  $("progressText").textContent = text;
  if (frac != null) $("progressBar").style.width = Math.round(frac * 100) + "%";
}
function hideProgress() { $("progress").hidden = true; $("progressBar").style.width = "0"; }

async function audioPlan() {
  if (isVideo() && st.audioKind === "video") {
    return { buffer: await decodeAudio(st.src.file), start: st.start, duration: st.end - st.start, gain: st.gain };
  }
  if (!st.audioFile) throw new Error("Elige un archivo de audio en el panel «Audio»");
  const buffer = await decodeAudio(st.audioFile);
  if (isVideo()) return { buffer, start: st.audioStart, duration: st.end - st.start, gain: st.gain };
  const duration = st.audioEnd - st.audioStart;
  if (duration < 0.1) throw new Error("El tramo de audio es demasiado corto");
  return { buffer, start: st.audioStart, duration, gain: st.gain };
}

function emojis() {
  const v = $("emoji").value.trim();
  return v ? [...new Intl.Segmenter().segment(v)].map((s) => s.segment).filter((s) => s.trim()).slice(0, 3) : ["🔊"];
}

async function create(andSend) {
  if (!st.src || st.busy) return;
  pause();
  setBusy(true);
  estToken++;
  try {
    const audio = await audioPlan();
    const res = await createSticker({
      source: st.src, start: st.start, end: st.end, fps: st.fps, size: st.size, tf: tf(), crop: st.crop,
      syncMs: st.syncMs, audio, meta: { pack: $("pack").value.trim(), author: $("author").value.trim(), emojis: emojis() },
      onProgress: showProgress,
    });
    const rec = await library.add({ name: st.src.file.name, webp: res.webp, ogg: res.ogg, info: res.info });
    st.result = rec;
    showResult(rec);
    renderLibrary();
    if (andSend) await send(rec);
    else hideProgress();
  } catch (e) {
    console.error(e);
    hideProgress();
    toast(e.message, "err");
  } finally {
    setBusy(false);
    scheduleEstimate();
  }
}
$("btnCreate").addEventListener("click", () => create(false));
$("btnCreateSend").addEventListener("click", () => create(true));

async function send(item) {
  showProgress("Preparando envío…", 0);
  const payload = {
    webpB64: bytesToB64(new Uint8Array(await item.webp.arrayBuffer())),
    oggB64: bytesToB64(new Uint8Array(await item.ogg.arrayBuffer())),
    info: item.info,
    dest: $("dest").value,
    openForwardDialog: $("openForward").checked,
  };
  const r = await wa("publish", payload);
  hideProgress();
  if (!r || !r.ok) throw new Error(r && r.error ? r.error : "No se pudo enviar");
  toast("✓ Enviado a " + r.data.chat.name, "ok");
}
async function sendSafe(item) {
  if (st.busy) return;
  setBusy(true);
  try { await send(item); } catch (e) { hideProgress(); toast(e.message, "err"); } finally { setBusy(false); }
}

const urls = new Map();
function urlFor(blob) {
  if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob));
  return urls.get(blob);
}
function playItem(item, img) {
  sfx.pause();
  const a = new Audio(urlFor(item.ogg));
  a.volume = 1;
  a.play().catch(() => {});
  if (img) { const src = img.src; img.src = ""; img.src = src; } // reinicia la animación
}
function download(item) {
  const base = (item.name || "sticker").replace(/\.[^.]+$/, "");
  for (const [blob, ext] of [[item.webp, "webp"], [item.ogg, "ogg"]]) {
    const a = document.createElement("a");
    a.href = urlFor(blob);
    a.download = `${base}.${ext}`;
    a.click();
  }
}

function showResult(item) {
  $("result").hidden = false;
  $("resultImg").src = urlFor(item.webp);
  const i = item.info;
  $("resultInfo").innerHTML =
    `${(i.durationMs / 1000).toFixed(1)} s · ${i.size} px · calidad ${Math.round(i.quality * 100)}<br>` +
    `${formatBytes(i.webpBytes + i.oggBytes)} (imagen ${formatBytes(i.webpBytes)} + audio ${formatBytes(i.oggBytes)})`;
}
function hideResult() { $("result").hidden = true; st.result = null; }
$("resultImg").addEventListener("click", () => st.result && playItem(st.result, $("resultImg")));
$("btnResultSend").addEventListener("click", () => st.result && sendSafe(st.result));
$("btnResultDl").addEventListener("click", () => st.result && download(st.result));

// ================================================================ biblioteca
async function renderLibrary() {
  let items = [];
  try { items = await library.all(); } catch (e) { /* sin IndexedDB */ }
  const grid = $("libGrid");
  grid.textContent = "";
  $("libEmpty").hidden = items.length > 0;
  $("libCount").textContent = items.length ? String(items.length) : "";
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "lib-item checker";
    const img = document.createElement("img");
    img.src = urlFor(item.webp);
    img.title = `${item.name || ""} — clic para escuchar`;
    img.addEventListener("click", () => playItem(item, img));
    const acts = document.createElement("div");
    acts.className = "acts";
    const mk = (name, title, fn, cls = "") => {
      const b = document.createElement("button");
      b.innerHTML = icon(name); b.title = title; b.className = cls;
      b.addEventListener("click", fn);
      acts.appendChild(b);
      return b;
    };
    mk("send", "Enviar al destino elegido", () => sendSafe(item), "lib-send");
    mk("download", "Descargar", () => download(item));
    mk("trash", "Borrar de la biblioteca", async () => {
      if (!confirm("¿Borrar este sticker de la biblioteca?")) return;
      await library.remove(item.id);
      renderLibrary();
    });
    el.append(img, acts);
    grid.appendChild(el);
  }
  refreshSendButtons();
}
renderLibrary();

// ================================================================ conexión con WhatsApp Web
async function wa(op, payload = {}) {
  if (!hasExt) return { ok: false, code: "NO_EXT", error: "Modo de prueba: abre el editor desde la extensión para enviar" };
  try {
    return await chrome.runtime.sendMessage({ to: "wa", op, payload });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

if (hasExt) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "yapper-progress") showProgress(msg.text, null);
  });
}

function setStatus(kind, text) {
  $("waStatus").className = "status " + kind;
  $("waStatusText").textContent = text;
}

let chatsLoaded = false;
async function pollStatus() {
  const r = await wa("ping");
  const was = st.connected;
  st.connected = !!(r && r.ok && r.data && r.data.ready);
  if (st.connected) setStatus("ok", "WhatsApp Web conectado");
  else if (r && r.code === "NO_EXT") setStatus("bad", "Modo de prueba (sin extensión)");
  else if (r && r.code === "NO_TAB") setStatus("warn", "Abrir WhatsApp Web");
  else if (r && r.ok) setStatus("warn", "WhatsApp Web cargando…");
  else setStatus("bad", "Sin conexión con WhatsApp Web");
  if (st.connected !== was) refreshSendButtons();
  if (st.connected && !chatsLoaded) loadChats();
  if (!st.connected) chatsLoaded = false;
}
setInterval(pollStatus, 3000);
pollStatus();

$("waStatus").addEventListener("click", () => {
  if (!hasExt) return toast("Instala la extensión y abre el editor desde su icono para enviar.");
  if (!st.connected) chrome.runtime.sendMessage({ to: "bg", op: "openWhatsApp" });
});

async function loadChats() {
  const r = await wa("chats");
  if (!r || !r.ok) return toast(r && r.error ? r.error : "No se pudo leer la lista de chats", "err");
  chatsLoaded = true;
  const sel = $("dest");
  const keep = sel.value || prefs.dest || "self";
  sel.querySelectorAll("optgroup").forEach((g) => g.remove());
  const groups = { contacto: "Contactos", grupo: "Grupos" };
  for (const kind of ["contacto", "grupo"]) {
    const list = r.data.chats.filter((c) => c.kind === kind);
    if (!list.length) continue;
    const g = document.createElement("optgroup");
    g.label = groups[kind];
    for (const c of list) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "self";
}
$("btnChats").addEventListener("click", () => (st.connected ? loadChats() : toast("WhatsApp Web no está conectado")));
