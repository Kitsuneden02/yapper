// Adaptador de WhatsApp Web (mundo MAIN de la página).
// Es la única pieza que usa el código interno de WhatsApp: si WhatsApp cambia algo, se arregla aquí.
(() => {
  if (window.__yapperMain) return;
  window.__yapperMain = true;

  const PATCHED = Symbol.for("yapper.patched");
  const OGG_MIME = "audio/ogg; codecs=opus";
  const noop = () => {};
  const yes = () => true;

  // ─────────────────────────────────────────────────────────────── Módulos internos
  const Modules = {
    available() {
      return typeof window.require === "function";
    },
    get(name) {
      const namespaced = window.importNamespace;
      if (typeof namespaced === "function") {
        try {
          const found = namespaced(name);
          if (found) return found;
        } catch (_) { /* se intenta con require */ }
      }
      return window.require(name);
    },
    getDefault(name) {
      const mod = this.get(name);
      return mod?.default ?? mod;
    },
    async getLazy(name, ms = 15000) {
      try { return this.get(name); } catch (_) { /* todavía no está cargado */ }
      if (typeof window.requireLazy !== "function") throw new Error(`WhatsApp no ofrece el módulo ${name}`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`El módulo ${name} tardó demasiado en cargar`)), ms);
        window.requireLazy([name], () => {
          clearTimeout(timer);
          try { resolve(this.get(name)); } catch (e) { reject(e); }
        });
      });
    },
  };

  // ─────────────────────────────────────────────────────────────── Función «stickers con sonido»
  // WhatsApp la activa por cuenta. Se fuerza solo en esta pestaña.
  const SoundStickers = {
    flags: new Set([
      "sound_stickers_consumption_enabled",
      "sound_stickers_creation_enabled",
      "sound_stickers_audio_playing_enabled",
    ]),
    active: false,

    patchFlags() {
      const props = Modules.get("WAWebABProps");
      const base = props.getABPropConfigValue;
      if (base[PATCHED]) return;
      const flags = this.flags;
      const wrapped = function (key, ...rest) {
        return flags.has(key) ? true : base.call(this, key, ...rest);
      };
      wrapped[PATCHED] = true;
      props.getABPropConfigValue = wrapped;
    },

    enable() {
      if (this.active) return true;
      try { this.patchFlags(); } catch (_) { /* se intenta con el módulo de control */ }
      let gate;
      try { gate = Modules.get("WAWebSoundStickerGating"); } catch (_) { return false; }
      const isOn = () => {
        try { return gate.isSoundStickerCreationEnabled() === true && gate.isSoundStickerConsumptionEnabled() === true; }
        catch (_) { return false; }
      };
      if (!isOn()) {
        try {
          Object.assign(gate, {
            isSoundStickerCreationEnabled: yes,
            isSoundStickerConsumptionEnabled: yes,
            isSoundStickerPlaybackEnabled: yes,
          });
        } catch (_) { /* propiedades de solo lectura */ }
      }
      this.active = isOn();
      return this.active;
    },
  };

  // ─────────────────────────────────────────────────────────────── Chats
  const Chats = {
    collection() {
      return Modules.get("WAWebChatCollection").ChatCollection;
    },
    ready() {
      try { return Modules.available() && !!this.collection(); } catch (_) { return false; }
    },
    describe(chat) {
      const id = chat.id;
      const title = chat.formattedTitle || chat.name || chat.contact?.name || chat.contact?.pushname || id?.user || "?";
      return { id: String(id?._serialized ?? id), name: String(title), kind: id?.server === "g.us" ? "grupo" : "contacto" };
    },
    recent(limit = 100) {
      const coll = this.collection();
      const models = coll.getModelsArray?.() ?? coll._models ?? coll.models ?? [];
      const hidden = new Set(["broadcast", "newsletter"]);
      return models
        .filter((chat) => chat.id?.server && !hidden.has(chat.id.server) && !chat.archive)
        .sort((a, b) => (b.t || 0) - (a.t || 0))
        .slice(0, limit)
        .map((chat) => this.describe(chat));
    },
    active() {
      return this.collection().getActive() || null;
    },
    async self() {
      const me = Modules.get("WAWebUserPrefsMeUser");
      const ids = ["getMaybeMePnUser", "getMeUserOrThrow", "getMaybeMeLidUser"]
        .map((getter) => { try { return typeof me[getter] === "function" ? me[getter]() : null; } catch (_) { return null; } })
        .filter(Boolean);
      if (!ids.length) throw new Error("No se pudo obtener tu propio número");
      const coll = this.collection();
      for (const wid of ids) {
        const chat = coll.get(wid) ?? coll.get(String(wid._serialized ?? wid));
        if (chat) return chat;
      }
      const created = await Modules.get("WAWebFindChatAction").findOrCreateLatestChat(ids[0], "forwardSelectedModals");
      return created?.chat ?? created ?? null;
    },
    async resolve(dest) {
      if (dest === "self") return this.self();
      if (dest === "active") {
        const chat = this.active();
        if (!chat) throw new Error("No hay ningún chat abierto en WhatsApp Web");
        return chat;
      }
      const chat = this.collection().get(dest);
      if (!chat) throw new Error("No se encontró el chat elegido");
      return chat;
    },
  };

  // ─────────────────────────────────────────────────────────────── Bytes
  const Bytes = {
    toBase64(value) {
      if (value == null || typeof value === "string") return value;
      const view = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
      let text = "";
      for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000));
      return btoa(text);
    },
    async sha256(data) {
      return this.toBase64(await crypto.subtle.digest("SHA-256", data));
    },
  };

  // ─────────────────────────────────────────────────────────────── Subida y envío
  const Sender = {
    uploadParams(blob, chat) {
      let uploadOrigin = 1;
      try { uploadOrigin = Modules.getDefault("WAWebMediaGetUploadOriginForChat")(chat); } catch (_) { /* valor por defecto */ }
      return {
        type: Modules.get("WAWebMmsMediaTypes").MEDIA_TYPES.AUDIO,
        blob,
        uploadOrigin,
        signal: new AbortController().signal,
        uploadQpl: new Proxy({}, { get: () => noop }), // métricas internas: se ignoran
        fileOrigin: undefined,
        userUploadAttemptCount: 0,
        forwardedFromWeb: false,
        isViewOnce: false,
        isHdPhoto: false,
      };
    },

    async encryptAndUpload(params) {
      const strategies = [
        () => Modules.getDefault("WAWebUploadManagerMainThread")
          .encryptAndUpload(params, Modules.getDefault("WAWebCreateMediaUploadMetrics")(params)),
        () => Modules.getDefault("WAWebUploadManager").encryptAndUpload(params),
      ];
      let failure;
      for (const run of strategies) {
        try { return await run(); } catch (e) { failure = e; }
      }
      throw failure;
    },

    /** Sube el Ogg como audio y devuelve la referencia que WhatsApp adjunta al sticker. */
    async uploadStickerAudio(ogg, seconds, chat) {
      const uploaded = await this.encryptAndUpload(this.uploadParams(ogg, chat));
      const plain = new Uint8Array(await ogg.arrayBuffer());
      const ref = {
        mimetype: OGG_MIME,
        duration: seconds,
        size: plain.length,
        filehash: await Bytes.sha256(plain),
        directPath: uploaded.directPath,
        deprecatedMms3Url: uploaded.url || undefined,
        mediaKey: Bytes.toBase64(uploaded.mediaKey),
        mediaKeyTimestamp: uploaded.mediaKeyTimestamp,
        encFilehash: Bytes.toBase64(uploaded.encFilehash),
      };
      let valid = true;
      try { valid = Modules.get("WAWebSoundStickerUtils").isCompleteStickerAudio(ref); } catch (_) { /* sin validador */ }
      if (valid !== true) throw new Error("WhatsApp no aceptó el audio subido");
      return ref;
    },

    async sendSticker(chat, webp, info, stickerAudio) {
      const side = info.size || 512;
      const mediaBlob = await Modules.getDefault("WAWebMediaOpaqueData").createFromData(webp, "image/webp");
      const MediaPrep = Modules.getDefault("WAWebMediaPrep");
      const draft = new MediaPrep("sticker", Promise.resolve({
        type: "sticker",
        mimetype: "image/webp",
        mediaBlob,
        size: webp.size,
        fullWidth: side,
        fullHeight: side,
        isAnimated: info.isAnimated !== false,
        emojis: info.emojis?.length ? info.emojis : ["🔊"],
      }));
      const outcome = await draft.sendToChat({ chat, options: { stickerAudio } });
      const { SendMsgResult } = Modules.get("WAWebSendMsgResultAction");
      if (outcome?.messageSendResult !== SendMsgResult.OK) {
        throw new Error(`WhatsApp no pudo enviar el sticker (${outcome?.messageSendResult})`);
      }
      return outcome.msg;
    },

    waitUntilSent(msg, timeoutMs = 30000) {
      const { ACK } = Modules.get("WAWebAck");
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (msg.ack < 0) {
            clearInterval(timer);
            reject(new Error("El mensaje quedó con error"));
          } else if (msg.ack >= ACK.SENT || Date.now() - started > timeoutMs) {
            clearInterval(timer);
            resolve(msg.ack);
          }
        }, 250);
      });
    },

    async openForwardDialog(msg) {
      const React = Modules.get("react");
      const modals = Modules.get("WAWebModalManager");
      const flow = await Modules.getLazy("WAWebForwardMessageFlowLoadable");
      const { unproxy } = Modules.get("WAWebStateUtils");
      let model = msg;
      try { model = Modules.get("WAWebMsgCollection").MsgCollection.get(msg.id) ?? msg; } catch (_) { /* usar el mensaje recibido */ }
      const close = modals.closeModalManager ?? (() => modals.ModalManager.close());
      modals.ModalManager.open(
        React.createElement(flow.ForwardMessageFlowLoadable, { msgs: [unproxy(model)], onClose: close, onForward: noop }),
        { transition: "modal-flow" },
      );
    },
  };

  // ─────────────────────────────────────────────────────────────── Operaciones expuestas al editor
  const reply = (payload) => window.postMessage({ __yapper: "fromMain", ...payload }, location.origin);
  const progress = (text) => reply({ kind: "progress", text });

  const operations = {
    async ping() {
      let waVersion = null;
      try { waVersion = window.Debug?.VERSION ?? null; } catch (_) { /* sin versión */ }
      return { ready: Chats.ready(), waVersion };
    },

    async chats() {
      if (!Chats.ready()) throw new Error("WhatsApp Web todavía está cargando");
      let active = null;
      try { const chat = Chats.active(); active = chat ? Chats.describe(chat) : null; } catch (_) { /* nada abierto */ }
      return { chats: Chats.recent(), active };
    },

    async publish({ webp, ogg, info, dest = "self", openForwardDialog = false }) {
      if (!Chats.ready()) throw new Error("WhatsApp Web todavía está cargando");
      if (!SoundStickers.enable()) progress("Aviso: no se pudo activar la función de stickers con sonido; el audio podría descartarse");
      progress("Buscando el chat…");
      const chat = await Chats.resolve(dest);
      progress("Subiendo el audio…");
      const stickerAudio = await Sender.uploadStickerAudio(new Blob([ogg], { type: OGG_MIME }), info.audioSeconds, chat);
      progress("Enviando el sticker…");
      const msg = await Sender.sendSticker(chat, new Blob([webp], { type: "image/webp" }), info, stickerAudio);
      progress("Esperando confirmación…");
      await Sender.waitUntilSent(msg);
      if (openForwardDialog) {
        progress("Abriendo Reenviar…");
        await Sender.openForwardDialog(msg);
      }
      return { chat: Chats.describe(chat) };
    },
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.__yapper !== "toMain") return;
    const { id, op, payload } = event.data;
    let result;
    try {
      const handler = operations[op];
      if (!handler) throw new Error(`Operación desconocida: ${op}`);
      result = { ok: true, data: await handler(payload || {}) };
    } catch (e) {
      result = { ok: false, error: String(e?.message || e) };
    }
    reply({ kind: "reply", id, result });
  });
})();
