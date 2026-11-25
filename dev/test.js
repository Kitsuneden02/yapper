// Prueba de extremo a extremo de la conversión (sin WhatsApp).
import { loadSource, decodeAudio } from "../editor/lib/media.js";
import { createSticker } from "../editor/lib/pipeline.js";
import { orientedSize, maxSquare } from "../editor/lib/render.js";
import { sha256b64 } from "../editor/lib/util.js";

const out = document.getElementById("out");
const log = (...a) => { out.textContent += a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n"; };
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); log((ok ? "OK   " : "FAIL ") + name, detail ?? ""); };

// Video sintético: cuadrantes de color + círculo que se mueve + tono de 440 Hz.
async function makeVideo(seconds = 3) {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 360;
  const ctx = c.getContext("2d");
  const draw = (t) => {
    ctx.fillStyle = "#f00"; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = "#0f0"; ctx.fillRect(320, 0, 320, 180);
    ctx.fillStyle = "#00f"; ctx.fillRect(0, 180, 320, 180);
    ctx.fillStyle = "#ff0"; ctx.fillRect(320, 180, 320, 180);
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(320 + Math.sin(t * 3) * 250, 180, 20, 0, Math.PI * 2); ctx.fill();
  };
  draw(0);
  const ac = new AudioContext();
  await ac.resume().catch(() => {});
  const osc = ac.createOscillator();
  osc.frequency.value = 440;
  const dest = ac.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus" });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  rec.start();
  const t0 = performance.now();
  await new Promise((resolve) => {
    const id = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      draw(t);
      if (t >= seconds) { clearInterval(id); resolve(); }
    }, 1000 / 30);
  });
  rec.stop();
  await done;
  osc.stop(); ac.close();
  return new File(chunks, "sintetico.webm", { type: "video/webm" });
}

// WAV mono de 2 s (sin AudioContext).
function makeWav(seconds = 2, sr = 44100) {
  const n = seconds * sr;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.sin((i / sr) * 2 * Math.PI * 330) * 12000, true);
  return new File([buf], "tono.wav", { type: "audio/wav" });
}

function makePng() {
  const c = document.createElement("canvas");
  c.width = 300; c.height = 200;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#0ff"; ctx.fillRect(0, 0, 300, 200);
  return new Promise((r) => c.toBlob((b) => r(new File([b], "img.png", { type: "image/png" })), "image/png"));
}

function readExifJson(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = new TextDecoder().decode(bytes.subarray(o, o + 4));
    const size = dv.getUint32(o + 4, true);
    if (id === "EXIF") {
      const d = bytes.subarray(o + 8, o + 8 + size);
      const len = new DataView(d.buffer, d.byteOffset).getUint32(14, true);
      return JSON.parse(new TextDecoder().decode(d.subarray(22, 22 + len)));
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

async function inspect(name, res, expect) {
  const webp = new Uint8Array(await res.webp.arrayBuffer());
  const ogg = new Uint8Array(await res.ogg.arrayBuffer());
  const img = document.createElement("img");
  img.src = URL.createObjectURL(res.webp);
  img.title = name;
  document.getElementById("imgs").appendChild(img);

  check(`${name}: sticker ≤ 1 MB`, webp.length <= 1_000_000, webp.length);
  const dec = new ImageDecoder({ data: webp, type: "image/webp" });
  await dec.tracks.ready;
  const frameCount = dec.tracks.selectedTrack.frameCount;
  check(`${name}: WebP animado decodificable`, dec.tracks.selectedTrack.animated && frameCount >= 1, { frameCount });
  const { image } = await dec.decode({ frameIndex: 0 });
  check(`${name}: tamaño ${expect.size}px`, image.displayWidth === expect.size && image.displayHeight === expect.size, [image.displayWidth, image.displayHeight]);
  if (expect.pixels) {
    const c = new OffscreenCanvas(image.displayWidth, image.displayHeight);
    const ctx = c.getContext("2d");
    ctx.drawImage(image, 0, 0);
    for (const [px, py, rgba, label] of expect.pixels) {
      const d = ctx.getImageData(Math.round(px * c.width), Math.round(py * c.height), 1, 1).data;
      const ok = rgba.every((v, i) => Math.abs(v - d[i]) < 60);
      check(`${name}: píxel ${label}`, ok, [...d]);
    }
  }
  image.close();
  dec.close();

  const exif = readExifJson(webp);
  const sha = await sha256b64(ogg);
  check(`${name}: EXIF con sound-sha256 correcto`, exif && exif["sound-sha256"] === sha, exif);

  const ac = new AudioContext();
  try {
    const ab = await ac.decodeAudioData(ogg.slice().buffer);
    check(`${name}: Ogg/Opus decodificable, duración ≈ ${expect.audio}s`, Math.abs(ab.duration - expect.audio) < 0.08 && ab.sampleRate > 0, { dur: ab.duration, bytes: ogg.length });
    const d = ab.getChannelData(0);
    let peak = 0;
    for (const v of d) peak = Math.max(peak, Math.abs(v));
    check(`${name}: el audio no está vacío`, peak > 0.05, { peak: +peak.toFixed(3) });
  } catch (e) {
    check(`${name}: Ogg/Opus decodificable`, false, e.message);
  } finally {
    ac.close();
  }
  log("   info:", res.info);
}

async function run() {
  out.textContent = "";
  results.length = 0;
  const tf0 = { rot: 0, flipH: false, flipV: false };
  const wav = makeWav(2);

  log("Generando video sintético…");
  const vfile = await makeVideo(3);
  const src = await loadSource(vfile);
  log("video", { w: src.w, h: src.h, dur: src.duration });

  // 1) Cuadrado centrado, audio del video
  let audio;
  try {
    const buf = await decodeAudio(vfile);
    audio = { buffer: buf, start: 0.5, duration: 2, gain: 1 };
    log("audio del video: ok", buf.duration);
  } catch (e) {
    log("audio del video no disponible (" + e.message + "), uso WAV");
    audio = { buffer: await decodeAudio(wav), start: 0, duration: 2, gain: 1 };
  }
  const [OW, OH] = orientedSize(src.w, src.h, 0);
  let res = await createSticker({ source: src, start: 0.5, end: 2.5, fps: 15, size: 512, tf: tf0, crop: maxSquare(OW, OH), audio, meta: { pack: "Pruebas", author: "dev" } });
  await inspect("centrado", res, { size: 512, audio: 2 });

  // 2) Recorte del cuadrante superior izquierdo (rojo) + audio WAV aparte
  const q = { x: 20, y: 20, w: 140, h: 140 };
  res = await createSticker({ source: src, start: 0, end: 1, fps: 12, size: 384, tf: tf0, crop: q, audio: { buffer: await decodeAudio(wav), start: 0, duration: 1, gain: 1 }, meta: {} });
  await inspect("recorte rojo", res, { size: 384, audio: 1, pixels: [[0.5, 0.5, [255, 0, 0, 255], "centro rojo"]] });

  // 3) Rotado 90° + recorte libre (bordes transparentes)
  const tf90 = { rot: 90, flipH: false, flipV: false };
  const [RW, RH] = orientedSize(src.w, src.h, 90); // 360x640
  res = await createSticker({ source: src, start: 0, end: 1, fps: 10, size: 256, tf: tf90, crop: { x: 0, y: 0, w: RW, h: RH }, audio: { buffer: await decodeAudio(wav), start: 0, duration: 1, gain: 1 }, meta: {} });
  // tras rotar 90° a la derecha, arriba-izquierda del resultado = abajo-izquierda del original (azul)
  await inspect("rotado libre", res, { size: 256, audio: 1, pixels: [[0.02, 0.5, [0, 0, 0, 0], "borde transparente"], [0.4, 0.1, [0, 0, 255, 255], "esquina azul"]] });

  // 4) Volteo horizontal + cuadrado: izquierda del resultado = derecha del original (verde arriba)
  res = await createSticker({ source: src, start: 0, end: 1, fps: 10, size: 256, tf: { rot: 0, flipH: true, flipV: false }, crop: { x: 0, y: 0, w: 180, h: 180 }, audio: { buffer: await decodeAudio(wav), start: 0, duration: 1, gain: 1 }, meta: {} });
  await inspect("volteado", res, { size: 256, audio: 1, pixels: [[0.3, 0.3, [0, 255, 0, 255], "verde"]] });

  // 5) Imagen fija + audio
  const isrc = await loadSource(await makePng());
  res = await createSticker({ source: isrc, start: 0, end: 0, fps: 15, size: 512, tf: tf0, crop: maxSquare(isrc.w, isrc.h), audio: { buffer: await decodeAudio(wav), start: 0.25, duration: 1.5, gain: 1 }, meta: {} });
  await inspect("imagen fija", res, { size: 512, audio: 1.5, pixels: [[0.5, 0.5, [0, 255, 255, 255], "cian"]] });

  const failed = results.filter((r) => !r.ok).length;
  log(`\n${results.length - failed}/${results.length} comprobaciones OK`);
  window.__testResult = { total: results.length, failed, results };
}

document.getElementById("run").addEventListener("click", () => run().catch((e) => { log("ERROR", e.stack || e.message); window.__testResult = { error: String(e.stack || e) }; }));
