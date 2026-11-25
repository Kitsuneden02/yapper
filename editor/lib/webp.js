// Arma un WebP animado (VP8X + ANIM + ANMF + EXIF) a partir de cuadros WebP sueltos.
import { concatBytes } from "./util.js";

const enc = new TextEncoder();

function readChunks(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = new TextDecoder().decode(bytes.subarray(8, 12));
  if (tag !== "WEBP") throw new Error("El cuadro no es WebP");
  const chunks = [];
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = new TextDecoder().decode(bytes.subarray(o, o + 4));
    const size = dv.getUint32(o + 4, true);
    chunks.push({ id, data: bytes.subarray(o + 8, o + 8 + size) });
    o += 8 + size + (size & 1);
  }
  return chunks;
}

function chunk(id, data) {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  out.set(enc.encode(id), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function u24(arr, o, v) {
  arr[o] = v & 0xff;
  arr[o + 1] = (v >> 8) & 0xff;
  arr[o + 2] = (v >> 16) & 0xff;
}

/** Bloque EXIF (TIFF little-endian) con el tag 0x5741 que lee WhatsApp. */
export function stickerExif(meta) {
  const json = enc.encode(JSON.stringify(meta));
  const head = new Uint8Array([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF LE, IFD en 8
    0x01, 0x00, // 1 entrada
    0x41, 0x57, 0x07, 0x00, // tag 0x5741, tipo UNDEFINED
    0, 0, 0, 0, // longitud
    0x16, 0x00, 0x00, 0x00, // offset de los datos (22)
  ]);
  new DataView(head.buffer).setUint32(14, json.length, true);
  return concatBytes([head, json]);
}

/**
 * @param {{bytes: Uint8Array, duration: number}[]} frames cuadros WebP del tamaño del lienzo
 */
export function buildAnimatedWebp(frames, width, height, exif) {
  const parts = [];
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x10 | 0x02 | (exif ? 0x08 : 0); // alpha + animación (+ EXIF)
  u24(vp8x, 4, width - 1);
  u24(vp8x, 7, height - 1);
  parts.push(chunk("VP8X", vp8x));
  parts.push(chunk("ANIM", new Uint8Array([0, 0, 0, 0, 0, 0]))); // fondo transparente, bucle infinito

  for (const f of frames) {
    const sub = readChunks(f.bytes).filter((c) => c.id === "ALPH" || c.id === "VP8 " || c.id === "VP8L");
    const hdr = new Uint8Array(16);
    u24(hdr, 0, 0);
    u24(hdr, 3, 0);
    u24(hdr, 6, width - 1);
    u24(hdr, 9, height - 1);
    u24(hdr, 12, Math.max(8, Math.min(0xffffff, Math.round(f.duration))));
    hdr[15] = 0x02; // sin mezcla: cada cuadro reemplaza al anterior
    parts.push(chunk("ANMF", concatBytes([hdr, ...sub.map((c) => chunk(c.id, c.data))])));
  }
  if (exif) parts.push(chunk("EXIF", exif));

  const body = concatBytes(parts);
  const riff = new Uint8Array(12);
  riff.set(enc.encode("RIFF"), 0);
  new DataView(riff.buffer).setUint32(4, body.length + 4, true);
  riff.set(enc.encode("WEBP"), 8);
  return concatBytes([riff, body]);
}
