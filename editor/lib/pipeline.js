// Pipeline completo: audio → Ogg/Opus, cuadros → WebP animado con EXIF, ajustado a 1 MB.
import { drawFrame } from "./render.js";
import { frameReader, renderAudio } from "./media.js";
import { encodeOggOpus } from "./ogg-opus.js";
import { buildAnimatedWebp, stickerExif } from "./webp.js";
import { sha256b64 } from "./util.js";

export const STICKER_LIMIT = 1_000_000 - 4096; // margen bajo el límite del servidor
export const AUDIO_LIMIT = 1_000_000;

/** Tiempos de muestreo (mitad de cada intervalo) y duración entera en ms de cada cuadro. */
export function frameTimes(start, end, fps) {
  const n = Math.max(1, Math.round((end - start) * fps));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      t: start + (i + 0.5) / fps,
      duration: Math.round(((i + 1) * 1000) / fps) - Math.round((i * 1000) / fps),
    });
  }
  return out;
}

function makeCanvas(size) {
  const c = new OffscreenCanvas(size, size);
  return { c, ctx: c.getContext("2d") };
}

async function toWebp(canvas, quality) {
  const blob = await canvas.convertToBlob({ type: "image/webp", quality });
  if (blob.type !== "image/webp") throw new Error("Este navegador no puede codificar WebP");
  return new Uint8Array(await blob.arrayBuffer());
}

const sigCtx = new OffscreenCanvas(16, 16).getContext("2d", { willReadFrequently: true });
function signature(bitmap) {
  sigCtx.clearRect(0, 0, 16, 16);
  sigCtx.drawImage(bitmap, 0, 0, 16, 16);
  return sigCtx.getImageData(0, 0, 16, 16).data;
}

function sameFrame(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length < 0.8;
}

/** Captura los cuadros ya encuadrados, fusionando repetidos consecutivos. */
export async function captureFrames(source, plan, onProgress = () => {}) {
  const { tf, crop, size } = plan;
  const reader = await frameReader(source);
  const { c, ctx } = makeCanvas(size);
  const frames = [];
  try {
    const times = source.kind === "image"
      ? [{ t: 0, duration: Math.round(plan.durationMs) }]
      : frameTimes(plan.start, plan.end, plan.fps);
    let prevSig = null;
    for (let i = 0; i < times.length; i++) {
      const img = await reader.at(times[i].t);
      drawFrame(ctx, img, source.w, source.h, tf, crop, size, size);
      const bmp = c.transferToImageBitmap();
      const s = signature(bmp);
      if (prevSig && sameFrame(prevSig, s)) {
        frames[frames.length - 1].duration += times[i].duration;
        bmp.close();
      } else {
        frames.push({ bitmap: bmp, duration: times[i].duration });
        prevSig = s;
      }
      onProgress((i + 1) / times.length);
    }
  } finally {
    reader.close();
  }
  return frames;
}

async function encodeFrames(frames, size, quality, onProgress = () => {}) {
  const { c, ctx } = makeCanvas(size);
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(frames[i].bitmap, 0, 0, size, size);
    out.push({ bytes: await toWebp(c, quality), duration: frames[i].duration });
    onProgress((i + 1) / frames.length);
  }
  return out;
}

/** Estimación rápida del peso codificando unos pocos cuadros de muestra. */
export async function estimate(source, plan, { quality = 0.8, samples = 6 } = {}) {
  const reader = await frameReader(source);
  const { c, ctx } = makeCanvas(plan.size);
  try {
    const times = source.kind === "image" ? [{ t: 0 }] : frameTimes(plan.start, plan.end, plan.fps);
    const pick = [];
    const k = Math.min(samples, times.length);
    for (let i = 0; i < k; i++) pick.push(times[Math.floor(((i + 0.5) * times.length) / k)]);
    let total = 0;
    for (const p of pick) {
      const img = await reader.at(p.t);
      drawFrame(ctx, img, source.w, source.h, plan.tf, plan.crop, plan.size, plan.size);
      total += (await toWebp(c, quality)).length + 40;
    }
    return { bytes: Math.round((total / pick.length) * times.length) + 512, frames: times.length };
  } finally {
    reader.close();
  }
}

function attempts(size) {
  const list = [];
  for (const q of [0.82, 0.7, 0.58, 0.46, 0.36]) list.push({ size, quality: q });
  for (const f of [0.8, 0.65, 0.5]) {
    const s = Math.max(96, Math.round((size * f) / 8) * 8);
    for (const q of [0.6, 0.45, 0.35]) list.push({ size: s, quality: q });
  }
  return list;
}

/**
 * opts: { source, start, end, fps, size, tf, crop,
 *         audio: { buffer, start, duration, gain }, meta: { pack, author, emojis }, onProgress(text, frac) }
 */
export async function createSticker(opts) {
  const { source, audio, meta } = opts;
  const progress = opts.onProgress || (() => {});

  // Compensación de desfase (solo con animación):
  //  > 0 → el primer cuadro dura más: la imagen espera al audio (audio que llega tarde en el celular).
  //  < 0 → silencio al inicio del audio: el audio espera a la imagen.
  const syncMs = source.kind === "image" ? 0 : Math.round(opts.syncMs || 0);

  // 1. Audio
  progress("Procesando audio…", 0);
  let samples = await renderAudio(audio.buffer, audio.start, audio.duration, { gain: audio.gain });
  let audioDuration = audio.duration;
  if (syncMs < 0) {
    const pad = Math.round((-syncMs / 1000) * 48000);
    const padded = new Float32Array(samples.length + pad);
    padded.set(samples, pad);
    samples = padded;
    audioDuration += -syncMs / 1000;
  }
  let ogg = await encodeOggOpus(samples, { bitrate: 32000 });
  if (ogg.bytes.length > AUDIO_LIMIT) ogg = await encodeOggOpus(samples, { bitrate: 12000 });
  if (ogg.bytes.length > AUDIO_LIMIT) throw new Error("El audio es demasiado largo (pasa de 1 MB)");
  const soundSha = await sha256b64(ogg.bytes);

  // 2. Cuadros
  const durationMs = source.kind === "image" ? audio.duration * 1000 : (opts.end - opts.start) * 1000;
  const plan = { start: opts.start, end: opts.end, fps: opts.fps, size: opts.size, tf: opts.tf, crop: opts.crop, durationMs };
  const frames = await captureFrames(source, plan, (f) => progress("Capturando cuadros…", f));
  if (syncMs > 0) frames[0].duration += syncMs;

  // 3. WebP ajustado al límite
  const exif = stickerExif({
    "sticker-pack-id": crypto.randomUUID(),
    "sticker-pack-name": meta.pack || "",
    "sticker-pack-publisher": meta.author || "",
    emojis: meta.emojis && meta.emojis.length ? meta.emojis : ["🔊"],
    "sound-sha256": soundSha,
  });
  let webp = null;
  let chosen = null;
  try {
    const list = attempts(opts.size);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const label = i === 0 ? "Codificando sticker…" : `Ajustando a 1 MB (${a.size}px, calidad ${Math.round(a.quality * 100)})…`;
      const encoded = await encodeFrames(frames, a.size, a.quality, (f) => progress(label, f));
      const bytes = buildAnimatedWebp(encoded, a.size, a.size, exif);
      if (bytes.length <= STICKER_LIMIT) { webp = bytes; chosen = a; break; }
    }
  } finally {
    frames.forEach((f) => f.bitmap.close());
  }
  if (!webp) throw new Error("No cabe en 1 MB ni bajando calidad y resolución. Acorta el tramo o baja los fps.");

  progress("Listo", 1);
  return {
    webp: new Blob([webp], { type: "image/webp" }),
    ogg: ogg.blob,
    info: {
      size: chosen.size,
      quality: chosen.quality,
      frames: frames.length,
      durationMs: Math.round(durationMs + Math.max(0, syncMs)),
      audioSeconds: Math.max(1, Math.ceil(audioDuration)),
      audioDuration,
      syncMs,
      webpBytes: webp.length,
      oggBytes: ogg.bytes.length,
      isAnimated: true,
      emojis: meta.emojis && meta.emojis.length ? meta.emojis : ["🔊"],
    },
  };
}
