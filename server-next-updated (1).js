const http = require("node:http");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
const APPSHEET_WEBHOOK_SECRET = process.env.APPSHEET_WEBHOOK_SECRET;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const APPSHEET_ACCESS_KEY = process.env.APPSHEET_ACCESS_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const APPSHEET_APP_ID = "2fcbe396-aed0-4bb1-b90c-ff97a92fc4f0";
const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

const conversations = new Map();
const processedMessages = new Map();
const sentStatusNotifications = new Map();
const phoneQueues = new Map();

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = String(value ?? "").trim();
  if (!text) return null;
  text = text.replace(/[^0-9,.-]/g, "");
  if (!text) return null;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastComma > lastDot) text = text.replace(/\./g, "").replace(",", ".");
  else text = text.replace(/,/g, "");
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function money(value) {
  return new Intl.NumberFormat("es-NI", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function makeId(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function validName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80) return "";
  if (!/[a-záéíóúñ]/i.test(name)) return "";
  if (/^(usuario|user|cliente|whatsapp|unknown|desconocido)$/i.test(name)) return "";
  return name;
}

function cleanMaps() {
  const now = Date.now();
  for (const [key, at] of processedMessages) if (now - at > DEDUP_TTL_MS) processedMessages.delete(key);
  for (const [key, at] of sentStatusNotifications) if (now - at > DEDUP_TTL_MS) sentStatusNotifications.delete(key);
  for (const [key, state] of conversations) {
    if (now - state.updatedAt > CONVERSATION_TTL_MS) conversations.delete(key);
  }
}

async function sendWhatsAppMessage(to, body) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) throw new Error("Faltan variables de WhatsApp");
  const response = await fetch(`https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizePhone(to),
      type: "text",
      text: { preview_url: false, body }
    })
  });
  if (!response.ok) throw new Error(`Meta respondió ${response.status}: ${await response.text()}`);
  return response.json().catch(() => ({}));
}

async function appSheetAction(table, action, rows = [], properties = {}) {
  if (!APPSHEET_ACCESS_KEY) throw new Error("Falta APPSHEET_ACCESS_KEY");
  const response = await fetch(
    `https://www.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/${encodeURIComponent(table)}/Action`,
    {
      method: "POST",
      headers: { ApplicationAccessKey: APPSHEET_ACCESS_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        Action: action,
        Properties: { Locale: "en-US", Timezone: "Central America Standard Time", ...properties },
        Rows: rows
      })
    }
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`AppSheet ${table}/${action} respondió ${response.status}: ${text}`);
  if (!text) return [];
  try { return JSON.parse(text); } catch { return text; }
}

async function findRows(table, selector = `Filter(${table}, true)`) {
  const result = await appSheetAction(table, "Find", [], { Selector: selector });
  return Array.isArray(result) ? result : [];
}

async function findClientByPhone(phone) {
  const wanted = normalizePhone(phone);
  const rows = await findRows("Clientes");
  return rows.find((row) => normalizePhone(row["Teléfono"]) === wanted) || null;
}

async function getOrCreateClient(phone, suggestedName) {
  const normalized = normalizePhone(phone);
  const existing = await findClientByPhone(normalized);
  if (existing) return existing;
  const name = validName(suggestedName);
  if (!name) return null;
  const id = makeId("WAC");
  await appSheetAction("Clientes", "Add", [{
    "ID Cliente": id,
    Nombre: name,
    "Teléfono": normalized,
    Observaciones: "Cliente creado automáticamente desde WhatsApp"
  }]);
  return { "ID Cliente": id, Nombre: name, "Teléfono": normalized };
}

async function updateClientName(client, name) {
  const clean = validName(name);
  if (!client || !clean || client.Nombre === clean) return client;
  await appSheetAction("Clientes", "Edit", [{ "ID Cliente": client["ID Cliente"], Nombre: clean }]);
  return { ...client, Nombre: clean };
}

function nicaraguaDateParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Managua", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${value.month}/${value.day}/${value.year}`, time: `${value.hour}:${value.minute}:${value.second}` };
}

async function addOrderToAppSheet(order) {
  if (!order.clientId) throw new Error("El pedido no tiene un cliente asociado");
  const { date, time } = nicaraguaDateParts();
  const id = makeId("WA");
  await appSheetAction("Pedidos", "Add", [{
    "ID Pedido": id,
    Fecha: date,
    Hora: time,
    Cliente: order.clientId,
    Recogida: order.pickup,
    Entrega: order.delivery,
    "Descripción": order.details,
    Estado: "Pendiente",
    Observaciones: `Pedido recibido automáticamente por WhatsApp. Mensaje: ${order.sourceMessageId || "sin id"}`
  }]);
  return id;
}

async function updateOrderStatus(orderId, status) {
  if (!orderId) return;
  await appSheetAction("Pedidos", "Edit", [{ "ID Pedido": orderId, Estado: status }]);
}

function isYes(text) { return /^(si|sí|confirmo|correcto|dale|ok|esta bien)$/i.test(String(text).trim()); }
function isNo(text) { return /^(no|cancelar|cancela|cancelalo|cancélalo)$/i.test(String(text).trim()); }

function basicExtract(text) {
  const clean = String(text || "").trim();
  const normalized = normalizeText(clean);
  const quote = /(cuanto|precio|tarifa|cobran|cuesta)/.test(normalized) && !/(necesito|ocupo|quiero|mandame|traeme|compr)/.test(normalized);
  const order = /(necesito|ocupo|quiero|mandame|traeme|compr|recoger|llevar|entregar)/.test(normalized);
  let pickup = "", delivery = "", details = "";
  const pickupMatch = clean.match(/(?:en|de|desde)\s+([^,.]+?)(?=\s+(?:y\s+)?(?:me\s+)?(?:lo|la|los|las)?\s*(?:traigan|lleven|entreguen|para|hasta)\b|[,.]|$)/i);
  const deliveryMatch = clean.match(/(?:a|al|hasta|para|entrega(?:r)?\s+en)\s+([^,.]+)$/i);
  if (pickupMatch) pickup = pickupMatch[1].trim();
  if (deliveryMatch) delivery = deliveryMatch[1].trim();
  if (order) details = clean;
  return { intent: quote ? "quote" : order ? "order" : /hola|buenas|buenos dias|buenas tardes|buenas noches/.test(normalized) ? "greeting" : "other", details, pickup, delivery, confidence: 0.55 };
}

async function extractRequest(text) {
  if (!OPENAI_API_KEY) return basicExtract(text);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_TEXT_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Extrae datos para Mandados Chevita. Devuelve JSON con intent (order, quote, greeting, other), details, pickup, delivery, reference y confidence de 0 a 1. No inventes. Una consulta de precio es quote, no order. details describe qué comprar, recoger o entregar. pickup es comercio/origen. delivery incluye barrio/dirección y reference una referencia adicional." },
        { role: "user", content: text }
      ]
    })
  });
  if (!response.ok) {
    console.error(`Extracción IA falló (${response.status}); se usa análisis local`);
    return basicExtract(text);
  }
  const data = await response.json();
  try { return { ...basicExtract(text), ...JSON.parse(data.choices?.[0]?.message?.content || "{}") }; }
  catch { return basicExtract(text); }
}

async function downloadWhatsAppAudio(mediaId) {
  const metadata = await fetch(`https://graph.facebook.com/v26.0/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
  });
  if (!metadata.ok) throw new Error(`No se pudo consultar el audio: ${metadata.status}`);
  const info = await metadata.json();
  if (!info.url) throw new Error("Meta no devolvió la URL del audio");
  if (Number(info.file_size || 0) > 25 * 1024 * 1024) throw new Error("El audio supera 25 MB");
  const response = await fetch(info.url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!response.ok) throw new Error(`No se pudo descargar el audio: ${response.status}`);
  return { bytes: await response.arrayBuffer(), mimeType: info.mime_type || "audio/ogg" };
}

async function transcribeAudio(mediaId) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY para transcribir notas de voz");
  const audio = await downloadWhatsAppAudio(mediaId);
  const extension = audio.mimeType.includes("ogg") ? "ogg" : audio.mimeType.includes("mpeg") ? "mp3" : "audio";
  const form = new FormData();
  form.append("file", new Blob([audio.bytes], { type: audio.mimeType }), `nota.${extension}`);
  form.append("model", OPENAI_TRANSCRIBE_MODEL);
  form.append("language", "es");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form
  });
  if (!response.ok) throw new Error(`No se pudo transcribir el audio (${response.status})`);
  const data = await response.json();
  return String(data.text || "").trim();
}

function mergeExtracted(state, extracted) {
  if (extracted.details) state.details = String(extracted.details).trim();
  if (extracted.pickup) state.pickup = String(extracted.pickup).trim();
  const delivery = [extracted.delivery, extracted.reference].filter(Boolean).join(", ").trim();
  if (delivery) state.delivery = delivery;
}

async function askNext(phone, state) {
  if (!state.clientId) {
    state.step = "name";
    return sendWhatsAppMessage(phone, "¡Hola! 👋 ¿A nombre de quién registramos tu pedido?");
  }
  if (!state.details) {
    state.step = "details";
    return sendWhatsAppMessage(phone, `Claro${state.name ? `, ${state.name}` : ""} 👍 ¿Qué necesitas comprar, recoger o entregar?`);
  }
  if (!state.pickup) {
    state.step = "pickup";
    return sendWhatsAppMessage(phone, "Perfecto. ¿Dónde debemos comprarlo o recogerlo?");
  }
  if (!state.delivery) {
    state.step = "delivery";
    return sendWhatsAppMessage(phone, "¿Dónde te lo entregamos? Incluye una referencia de la casa, por favor.");
  }
  state.step = "confirm";
  return sendWhatsAppMessage(phone, [
    "Perfecto, tengo esto:",
    `• Pedido: ${state.details}`,
    `• Recogida: ${state.pickup}`,
    `• Entrega: ${state.delivery}`,
    "",
    "¿Confirmas que enviemos el pedido? Responde SI o NO."
  ].join("\n"));
}

async function handleQuote(phone, state, extracted) {
  state.intent = "quote";
  mergeExtracted(state, extracted);
  if (!state.pickup) { state.step = "quote_pickup"; return sendWhatsAppMessage(phone, "Claro. ¿Desde dónde debemos recogerlo?"); }
  if (!state.delivery) { state.step = "quote_delivery"; return sendWhatsAppMessage(phone, "¿Hasta qué barrio o dirección sería la entrega?"); }
  conversations.delete(phone);
  return sendWhatsAppMessage(phone, `Gracias. Cotizaremos el recorrido de ${state.pickup} a ${state.delivery} sin registrar un pedido todavía.`);
}

async function processText(phone, text, profileName, messageId) {
  cleanMaps();
  let state = conversations.get(phone);
  if (!state) state = { phone, updatedAt: Date.now(), sourceMessageId: messageId };
  state.updatedAt = Date.now();

  if (!state.clientId) {
    let client = await getOrCreateClient(phone, profileName);
    if (!client && state.step === "name") client = await getOrCreateClient(phone, text);
    if (client) {
      state.clientId = client["ID Cliente"];
      state.name = client.Nombre;
      if (state.step === "name") state.step = "details";
    } else {
      conversations.set(phone, state);
      return askNext(phone, state);
    }
  }

  if (state.step === "confirm_cost") {
    if (isYes(text)) {
      conversations.delete(phone);
      return sendWhatsAppMessage(phone, "✅ Confirmado. Tu motorizado comenzará a gestionar el pedido.");
    }
    if (isNo(text)) {
      await updateOrderStatus(state.orderId, "Cancelado");
      conversations.delete(phone);
      return sendWhatsAppMessage(phone, "Tu pedido fue cancelado. Cuando necesites otro mandado, escríbenos.");
    }
    return sendWhatsAppMessage(phone, "¿Confirmas el costo del servicio? Responde SI o NO.");
  }

  if (state.step === "confirm") {
    if (isYes(text)) {
      const orderId = await addOrderToAppSheet(state);
      conversations.delete(phone);
      return sendWhatsAppMessage(phone, "✅ Tu pedido fue registrado correctamente. Ya está disponible para nuestros motorizados. En cuanto uno lo tome, te avisaremos.");
    }
    if (isNo(text)) {
      conversations.delete(phone);
      return sendWhatsAppMessage(phone, "Listo, cancelé la solicitud. Escríbenos cuando necesites otro mandado.");
    }
    return sendWhatsAppMessage(phone, "Para confirmar responde SI; para cancelar responde NO.");
  }

  if (state.step === "name") {
    const client = await getOrCreateClient(phone, text);
    if (!client) return sendWhatsAppMessage(phone, "No logré identificar el nombre. ¿A nombre de quién registramos el pedido?");
    state.clientId = client["ID Cliente"];
    state.name = client.Nombre;
    state.step = "details";
  } else if (state.step === "details") state.details = text;
  else if (state.step === "pickup") state.pickup = text;
  else if (state.step === "delivery") state.delivery = text;
  else if (state.step === "quote_pickup") state.pickup = text;
  else if (state.step === "quote_delivery") state.delivery = text;
  else {
    const extracted = await extractRequest(text);
    if (extracted.intent === "quote") {
      conversations.set(phone, state);
      return handleQuote(phone, state, extracted);
    }
    if (extracted.intent === "greeting" || extracted.intent === "other") {
      state.step = "details";
    } else mergeExtracted(state, extracted);
  }

  conversations.set(phone, state);
  if (state.intent === "quote" || state.step === "quote_pickup" || state.step === "quote_delivery") return handleQuote(phone, state, {});
  return askNext(phone, state);
}

async function processIncomingMessage(message, profileName) {
  if (!message.from || !message.id) return;
  if (processedMessages.has(message.id)) {
    console.log(`Mensaje duplicado ignorado: ${message.id}`);
    return;
  }
  processedMessages.set(message.id, Date.now());
  let text = "";
  if (message.type === "text") text = String(message.text?.body || "").trim();
  else if (message.type === "audio" && message.audio?.id) {
    try {
      text = await transcribeAudio(message.audio.id);
      if (text.length < 4) throw new Error("Transcripción insuficiente");
      await sendWhatsAppMessage(message.from, `🎤 Entendí: “${text}”`);
    } catch (error) {
      console.error(`Audio ${message.id} no procesado: ${error.message}`);
      await sendWhatsAppMessage(message.from, "No pude entender bien esa nota de voz. ¿Puedes enviarla nuevamente más clara o escribir el mensaje?");
      return;
    }
  } else return;
  if (!text) return;
  await processText(normalizePhone(message.from), text, profileName, message.id);
}

function enqueueMessage(message, profileName) {
  const phone = normalizePhone(message.from);
  const previous = phoneQueues.get(phone) || Promise.resolve();
  const next = previous.then(() => processIncomingMessage(message, profileName));
  const queued = next.finally(() => { if (phoneQueues.get(phone) === queued) phoneQueues.delete(phone); });
  phoneQueues.set(phone, queued);
  return queued;
}

function getIncomingItems(event) {
  const items = [];
  for (const entry of event.entry || []) for (const change of entry.changes || []) {
    const value = change.value || {};
    const names = new Map((value.contacts || []).map((c) => [normalizePhone(c.wa_id), c.profile?.name || ""]));
    for (const message of value.messages || []) items.push({ message, profileName: names.get(normalizePhone(message.from)) || "" });
  }
  return items;
}

function verifyMetaSignature(rawBody, signature) {
  if (!META_APP_SECRET) return true;
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", META_APP_SECRET).update(rawBody).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function readRawBody(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("Solicitud demasiado grande")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function requireAppSheetSecret(req) {
  return Boolean(APPSHEET_WEBHOOK_SECRET && req.headers["x-chevita-secret"] === APPSHEET_WEBHOOK_SECRET);
}

async function notifyOrderStatus(data, forcedStatus = "") {
  // AppSheet sends the complete row when the webhook Body is left empty.
  // Accept both the compact API names and the real AppSheet column names.
  const phone = normalizePhone(data.telefono || data.phone || data["Teléfono"] || data.Telefono);
  const status = normalizeText(forcedStatus || data.estado || data.status || data.Estado);
  const orderId = String(data.idPedido || data.orderId || data["ID Pedido"] || "");
  if (!phone || !status) throw new Error("Faltan teléfono o estado");
  const dedupKey = `${orderId}:${status}`;
  if (orderId && sentStatusNotifications.has(dedupKey)) return { duplicate: true };
  if (orderId) sentStatusNotifications.set(dedupKey, Date.now());
  if (status === "en camino") await sendWhatsAppMessage(phone, "🛵 Tu pedido ya va en camino.");
  else if (status === "entregado") await sendWhatsAppMessage(phone, "✅ Tu pedido fue entregado. Gracias por utilizar Mandados Chevita.");
  else if (status === "cancelado") await sendWhatsAppMessage(phone, "Tu pedido fue cancelado. Si necesitas ayuda, escríbenos.");
  return { ok: true };
}

async function notifyAssignedOrder(data) {
  const phone = normalizePhone(data.telefono || data.phone);
  const service = parseMoney(data.costoServicio ?? data.deliveryCost);
  const orderId = String(data.idPedido || data.orderId || "");
  if (!phone) throw new Error("Falta el teléfono del cliente");
  if (service === null) throw new Error(`Costo del servicio inválido: ${String(data.costoServicio ?? data.deliveryCost ?? "vacío")}`);
  const dedupKey = `${orderId}:asignado:${service}`;
  if (sentStatusNotifications.has(dedupKey)) return { duplicate: true };
  sentStatusNotifications.set(dedupKey, Date.now());
  conversations.set(phone, { phone, step: "confirm_cost", orderId, service, updatedAt: Date.now() });
  await sendWhatsAppMessage(phone, [
    "🛵 Tu pedido ya fue tomado por uno de nuestros motorizados.",
    `El costo del mandado es de C$${money(service)}.`,
    "¿Confirmas el costo? Responde SI o NO."
  ].join("\n"));
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, JSON.stringify({ status: "ok", service: "Mandados Chevita WhatsApp webhook", version: "2.0" }), "application/json; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/webhook") {
    const valid = url.searchParams.get("hub.mode") === "subscribe" && VERIFY_TOKEN && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN;
    return send(res, valid ? 200 : 403, valid ? url.searchParams.get("hub.challenge") || "" : "Token de verificación inválido");
  }
  if (req.method === "POST" && url.pathname === "/webhook") {
    try {
      const raw = await readRawBody(req);
      if (!verifyMetaSignature(raw, req.headers["x-hub-signature-256"])) return send(res, 401, "Firma inválida");
      const event = JSON.parse(raw.toString("utf8") || "{}");
      send(res, 200, "EVENT_RECEIVED");
      for (const item of getIncomingItems(event)) enqueueMessage(item.message, item.profileName)
        .then(() => console.log(`Mensaje ${item.message.id} procesado (${item.message.type})`))
        .catch((error) => console.error(`Mensaje ${item.message.id} falló: ${error.message}`));
    } catch (error) { if (!res.writableEnded) send(res, 400, error.message); }
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/appsheet/")) {
    if (!requireAppSheetSecret(req)) return send(res, 403, "No autorizado");
    try {
      const data = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
      const result = url.pathname === "/appsheet/order-assigned" ? await notifyAssignedOrder(data)
        : url.pathname === "/appsheet/order-status" ? await notifyOrderStatus(data)
        : url.pathname === "/appsheet/order-status/en-camino" ? await notifyOrderStatus(data, "En Camino")
        : url.pathname === "/appsheet/order-status/entregado" ? await notifyOrderStatus(data, "Entregado")
        : null;
      if (!result) return send(res, 404, "No encontrado");
      return send(res, 200, JSON.stringify(result), "application/json; charset=utf-8");
    } catch (error) {
      console.error(`${url.pathname} falló: ${error.message}`);
      return send(res, 400, JSON.stringify({ ok: false, error: error.message }), "application/json; charset=utf-8");
    }
  }
  send(res, 404, "No encontrado");
});

if (require.main === module) server.listen(PORT, "0.0.0.0", () => console.log(`Webhook activo en el puerto ${PORT}`));

module.exports = {
  server, normalizePhone, normalizeText, parseMoney, validName, basicExtract,
  getIncomingItems, verifyMetaSignature, mergeExtracted, transcribeAudio
};
