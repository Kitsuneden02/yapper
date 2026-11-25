// Codifica audio mono a 48 kHz en Opus (WebCodecs) y lo empaqueta en Ogg.
import { concatBytes } from "./util.js";

const SR = 48000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return c;
}

function oggPage({ packets, granule, serial, seq, bos = false, eos = false }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const dataLen = packets.reduce((a, p) => a + p.length, 0);
  const buf = new Uint8Array(27 + lacing.length + dataLen);
  const dv = new DataView(buf.buffer);
  buf.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  buf[4] = 0;
  buf[5] = (bos ? 0x02 : 0) | (eos ? 0x04 : 0);
  dv.setBigUint64(6, BigInt(granule), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, seq, true);
  buf[26] = lacing.length;
  buf.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { buf.set(p, o); o += p.length; }
  dv.setUint32(22, oggCrc(buf), true);
  return buf;
}

function opusHead(preSkip) {
  const b = new Uint8Array(19);
  const dv = new DataView(b.buffer);
  b.set(new TextEncoder().encode("OpusHead"), 0);
  b[8] = 1; // versión
  b[9] = 1; // canales
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, SR, true);
  dv.setInt16(16, 0, true);
  b[18] = 0; // mapeo
  return b;
}

function opusTags() {
  const vendor = new TextEncoder().encode("yapper");
  const b = new Uint8Array(8 + 4 + vendor.length + 4);
  const dv = new DataView(b.buffer);
  b.set(new TextEncoder().encode("OpusTags"), 0);
  dv.setUint32(8, vendor.length, true);
  b.set(vendor, 12);
  dv.setUint32(12 + vendor.length, 0, true);
  return b;
}

function preSkipFrom(desc) {
  if (!desc || desc.length < 12) return null;
  const magic = new TextDecoder().decode(desc.subarray(0, 8));
  if (magic !== "OpusHead") return null;
  return new DataView(desc.buffer, desc.byteOffset).getUint16(10, true);
}

/** @param {Float32Array} samples mono, 48 kHz */
export async function encodeOggOpus(samples, { bitrate = 32000 } = {}) {
  if (typeof AudioEncoder === "undefined") throw new Error("Este navegador no tiene WebCodecs (AudioEncoder)");
  const packets = [];
  let desc = null;
  let error = null;
  const enc = new AudioEncoder({
    output(chunk, meta) {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      const n = chunk.duration ? Math.round((chunk.duration * SR) / 1e6) : 960;
      packets.push({ data: d, samples: n });
      const dc = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (dc && !desc) desc = dc instanceof ArrayBuffer ? new Uint8Array(dc) : new Uint8Array(dc.buffer, dc.byteOffset, dc.byteLength);
    },
    error(e) { error = e; },
  });
  const base = { codec: "opus", sampleRate: SR, numberOfChannels: 1, bitrate };
  const withOpts = { ...base, opus: { frameDuration: 20000, application: "audio" } };
  const cfg = (await AudioEncoder.isConfigSupported(withOpts).catch(() => ({ supported: false }))).supported ? withOpts : base;
  enc.configure(cfg);

  const CH = 4800;
  for (let i = 0; i < samples.length; i += CH) {
    const part = samples.slice(i, Math.min(i + CH, samples.length));
    const ad = new AudioData({
      format: "f32-planar", sampleRate: SR, numberOfFrames: part.length, numberOfChannels: 1,
      timestamp: Math.round((i * 1e6) / SR), data: part,
    });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  enc.close();
  if (error) throw error;
  if (!packets.length) throw new Error("El codificador de audio no produjo datos");

  const preSkip = preSkipFrom(desc) ?? 312;
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const pages = [];
  let seq = 0;
  pages.push(oggPage({ packets: [opusHead(preSkip)], granule: 0, serial, seq: seq++, bos: true }));
  pages.push(oggPage({ packets: [opusTags()], granule: 0, serial, seq: seq++ }));

  const totalCoded = packets.reduce((a, p) => a + p.samples, 0);
  const finalGranule = Math.min(preSkip + samples.length, totalCoded);
  let granule = 0;
  let group = [];
  let segs = 0;
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    const need = Math.floor(p.data.length / 255) + 1;
    if (group.length && (segs + need > 255 || group.length >= 50)) {
      pages.push(oggPage({ packets: group, granule, serial, seq: seq++ }));
      group = [];
      segs = 0;
    }
    group.push(p.data);
    segs += need;
    granule += p.samples;
  }
  pages.push(oggPage({ packets: group, granule: finalGranule, serial, seq: seq++, eos: true }));

  const bytes = concatBytes(pages);
  return { bytes, blob: new Blob([bytes], { type: "audio/ogg; codecs=opus" }) };
}
