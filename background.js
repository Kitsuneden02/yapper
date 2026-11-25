// Service worker: abre el editor y hace de relé entre el editor y la pestaña de WhatsApp Web.
const WA_URL = "https://web.whatsapp.com/";
const EDITOR_URL = chrome.runtime.getURL("editor/editor.html");

chrome.action.onClicked.addListener(async () => {
  const [tab] = await chrome.tabs.query({ url: EDITOR_URL + "*" });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: EDITOR_URL });
  }
});

// Al instalar/actualizar, las pestañas de WhatsApp ya abiertas no tienen los scripts: se inyectan.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: WA_URL + "*" });
  for (const t of tabs) inject(t.id).catch(() => {});
});

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/isolated.js"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/wa-main.js"], world: "MAIN" });
}

async function waTab() {
  const tabs = await chrome.tabs.query({ url: WA_URL + "*" });
  return tabs.find((t) => t.active) || tabs[0] || null;
}

async function relay(msg) {
  const tab = await waTab();
  if (!tab) return { ok: false, code: "NO_TAB", error: "WhatsApp Web no está abierto" };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // Pestaña abierta antes de instalar: inyectar y reintentar una vez.
    try {
      await inject(tab.id);
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e2) {
      return { ok: false, code: "NO_BRIDGE", error: "No se pudo conectar con WhatsApp Web: " + (e2.message || e2) };
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.to === "wa") {
    relay(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.to === "bg" && msg.op === "openWhatsApp") {
    waTab().then(async (t) => {
      if (t) {
        await chrome.tabs.update(t.id, { active: true });
        await chrome.windows.update(t.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: WA_URL });
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});
