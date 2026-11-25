// Carga de fuentes (video / imagen) y de audio.

function waitEvent(el, ok, bad = "error") {
  return new Promise((resolve, reject) => {
    const on = () => { off(); resolve(); };
    const fail = () => { off(); reject(new Error("No se pudo leer el archivo (formato no soportado)")); };
    const off = () => { el.removeEventListener(ok, on); el.removeEventListener(bad, fail); };
    el.addEventListener(ok, on);
    el.addEventListener(bad, fail);
  });
}

function seekTo(v, t) {
  return new Promise((resolve) => {
    const to = setTimeout(resolve, 3000);
    v.addEventListener("seeked", () => { clearTimeout(to); resolve(); }, { once: true });
    v.currentTime = t;
  });
}

export async function loadSource(file) {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith("video/") || /\.(mp4|webm|mov|mkv|m4v)$/i.test(file.name)) {
    const video = document.createElement("video");
    video.preload = "auto";
    video.playsInline = true;
    video.src = url;
    await waitEvent(video, "loadeddata");
    // Algunos videos (p. ej. recortados) tienen marcas de tiempo que no empiezan en 0: Chrome se
    // coloca en el primer cuadro. El audio decodificado sí empieza en 0, así que todo se mide
    // relativo a ese primer cuadro.
    const offset = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    // Chrome a veces corrige la duración solo al llegar al final: saltar al final hasta que se estabilice.
    for (let i = 0; i < 6 && Number.isFinite(video.duration); i++) {
      const d = video.duration;
      await seekTo(video, Math.max(0, d - 0.01));
      if (!(video.duration > d + 0.01)) break;
    }
    await seekTo(video, offset);
    return {
      kind: "video", file, url, el: video, offset,
      w: video.videoWidth, h: video.videoHeight, duration: Math.max(0.05, video.duration - offset),
    };
  }
  if (file.type.startsWith("image/")) {
    const bitmap = await createImageBitmap(file);
    return { kind: "image", file, url, bitmap, w: bitmap.width, h: bitmap.height, duration: null };
  }
  URL.revokeObjectURL(url);
  throw new Error("Tipo de archivo no soportado: " + (file.type || file.name));
}

/** Lector de cuadros independiente del reproductor de la interfaz. */
export async function frameReader(source) {
  if (source.kind === "image") {
    return { at: async () => source.bitmap, close() {} };
  }
  if (source.kind === "synthetic") {
    const c = new OffscreenCanvas(source.w, source.h);
    const ctx = c.getContext("2d");
    return { at: async (t) => { source.draw(ctx, t); return c; }, close() {} };
  }
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = source.url;
  await waitEvent(v, "loadeddata");
  return {
    async at(t) {
      const off = source.offset || 0;
      const target = Math.min(off + Math.max(0, t), Math.max(off, v.duration - 0.001));
      if (Math.abs(v.currentTime - target) > 1e-4 || v.readyState < 2) {
        const p = waitEvent(v, "seeked");
        v.currentTime = target;
        await p;
      }
      return v;
    },
    close() { v.removeAttribute("src"); v.load(); },
  };
}

const audioCache = new WeakMap();
export async function decodeAudio(file) {
  if (audioCache.has(file)) return audioCache.get(file);
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    audioCache.set(file, buf);
    return buf;
  } catch (e) {
    throw new Error("No se pudo leer el audio de «" + file.name + "» (¿el archivo no tiene sonido?)");
  } finally {
    ctx.close();
  }
}

/** Recorta, pasa a mono 48 kHz, aplica volumen y fundidos cortos en los bordes. */
export async function renderAudio(buffer, start, duration, { gain = 1, fadeMs = 8 } = {}) {
  const SR = 48000;
  const len = Math.max(1, Math.round(duration * SR));
  const off = new OfflineAudioContext(1, len, SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  const g = off.createGain();
  g.gain.value = gain;
  src.connect(g).connect(off.destination);
  src.start(0, Math.max(0, start), duration);
  const out = await off.startRendering();
  const d = out.getChannelData(0);
  const f = Math.min(Math.round((fadeMs / 1000) * SR), Math.floor(d.length / 2));
  for (let i = 0; i < f; i++) {
    const k = i / f;
    d[i] *= k;
    d[d.length - 1 - i] *= k;
  }
  for (let i = 0; i < d.length; i++) d[i] = Math.max(-1, Math.min(1, d[i]));
  return d;
}
