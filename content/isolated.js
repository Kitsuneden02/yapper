// Mundo aislado en WhatsApp Web: traduce mensajes de la extensión <-> script de la página (mundo MAIN).
(() => {
  if (window.__yapperIsolated) return;
  window.__yapperIsolated = true;

  const pending = new Map();
  let seq = 0;
  const TIMEOUTS = { ping: 5000, chats: 10000, publish: 180000 };

  function b64ToBuffer(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__yapper !== "fromMain") return;
    if (d.kind === "progress") {
      chrome.runtime.sendMessage({ type: "yapper-progress", text: String(d.text || "") }).catch(() => {});
    } else if (d.kind === "reply") {
      const p = pending.get(d.id);
      if (p) { pending.delete(d.id); clearTimeout(p.timer); p.respond(d.result); }
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.to !== "wa") return;
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      sendResponse({ ok: false, code: "TIMEOUT", error: "WhatsApp Web no respondió a tiempo" });
    }, TIMEOUTS[msg.op] || 30000);
    pending.set(id, { respond: sendResponse, timer });
    const payload = Object.assign({}, msg.payload);
    if (payload.webpB64) { payload.webp = b64ToBuffer(payload.webpB64); delete payload.webpB64; }
    if (payload.oggB64) { payload.ogg = b64ToBuffer(payload.oggB64); delete payload.oggB64; }
    window.postMessage({ __yapper: "toMain", id, op: msg.op, payload }, location.origin);
    return true;
  });
})();
