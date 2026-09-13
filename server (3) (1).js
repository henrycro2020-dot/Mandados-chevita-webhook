const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const APPSHEET_ACCESS_KEY = process.env.APPSHEET_ACCESS_KEY;
const APPSHEET_APP_ID = "2fcbe396-aed0-4bb1-b90c-ff97a92fc4f0";
const APPSHEET_TABLE = "Pedidos";

const conversations = new Map();

const WELCOME_MESSAGE = [
  "¡Hola! 👋 Gracias por escribir a Mandados Chevita.",
  "",
  "Para comenzar, escribe tu nombre."
].join("\n");

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

async function sendWhatsAppMessage(to, body) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltan WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID");
    return;
  }

  const response = await fetch(
    `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body }
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Meta respondió ${response.status}: ${error}`);
  }
}

function makeOrderId() {
  return `WA${Date.now().toString(36).toUpperCase()}`;
}

function nicaraguaDateParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Managua",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${value.month}/${value.day}/${value.year}`,
    time: `${value.hour}:${value.minute}:${value.second}`
  };
}

async function addOrderToAppSheet(order) {
  if (!APPSHEET_ACCESS_KEY) throw new Error("Falta APPSHEET_ACCESS_KEY");

  const { date, time } = nicaraguaDateParts();
  const response = await fetch(
    `https://www.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/${encodeURIComponent(APPSHEET_TABLE)}/Action`,
    {
      method: "POST",
      headers: {
        ApplicationAccessKey: APPSHEET_ACCESS_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        Action: "Add",
        Properties: {
          Locale: "en-US",
          Timezone: "Central America Standard Time"
        },
        Rows: [
          {
            "ID Pedido": makeOrderId(),
            Fecha: date,
            Hora: time,
            "Teléfono": order.phone,
            Recogida: order.pickup,
            Entrega: order.delivery,
            "Descripción": `${order.details} | Cliente: ${order.name}`,
            Estado: "Pendiente",
            Observaciones: "Pedido recibido automáticamente por WhatsApp"
          }
        ]
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`AppSheet respondió ${response.status}: ${error}`);
  }
}

async function processIncomingMessage(message) {
  if (!message.from || message.type !== "text") return;

  const text = message.text?.body?.trim();
  if (!text) return;

  const phone = message.from;
  const current = conversations.get(phone);

  if (!current || Date.now() - current.updatedAt > 30 * 60 * 1000) {
    conversations.set(phone, { step: "name", phone, updatedAt: Date.now() });
    await sendWhatsAppMessage(phone, WELCOME_MESSAGE);
    return;
  }

  current.updatedAt = Date.now();

  if (current.step === "name") {
    current.name = text;
    current.step = "pickup";
    await sendWhatsAppMessage(phone, `Gracias, ${text}. ¿Dónde debemos comprar o recoger el pedido?`);
    return;
  }

  if (current.step === "pickup") {
    current.pickup = text;
    current.step = "delivery";
    await sendWhatsAppMessage(phone, "¿En qué dirección debemos entregarlo?");
    return;
  }

  if (current.step === "delivery") {
    current.delivery = text;
    current.step = "details";
    await sendWhatsAppMessage(phone, "¿Qué necesitas comprar, recoger o entregar?");
    return;
  }

  if (current.step === "details") {
    current.details = text;
    current.step = "confirm";
    await sendWhatsAppMessage(
      phone,
      [
        "Confirma tu pedido:",
        `Nombre: ${current.name}`,
        `Recogida: ${current.pickup}`,
        `Entrega: ${current.delivery}`,
        `Detalle: ${current.details}`,
        "",
        "Responde SI para registrarlo o NO para cancelarlo."
      ].join("\n")
    );
    return;
  }

  if (current.step === "confirm") {
    const answer = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    if (answer === "si") {
      await addOrderToAppSheet(current);
      conversations.delete(phone);
      await sendWhatsAppMessage(
        phone,
        "✅ Tu pedido fue registrado. En breve Mandados Chevita confirmará el costo y asignará un motorizado."
      );
      return;
    }

    if (answer === "no") {
      conversations.delete(phone);
      await sendWhatsAppMessage(phone, "Pedido cancelado. Escribe HOLA cuando quieras comenzar otro.");
      return;
    }

    await sendWhatsAppMessage(phone, "Por favor responde únicamente SI o NO.");
  }
}

function getIncomingMessages(event) {
  return (event.entry || []).flatMap((entry) =>
    (entry.changes || []).flatMap((change) => change.value?.messages || [])
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    return send(
      res,
      200,
      JSON.stringify({ status: "ok", service: "Mandados Chevita WhatsApp webhook" }),
      "application/json; charset=utf-8"
    );
  }

  if (req.method === "GET" && url.pathname === "/webhook") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return send(res, 200, challenge || "");
    }

    return send(res, 403, "Token de verificación inválido");
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    let rawBody = "";

    req.on("data", (chunk) => {
      rawBody += chunk;
      if (rawBody.length > 1_000_000) req.destroy();
    });

    req.on("end", () => {
      try {
        const event = JSON.parse(rawBody || "{}");
        console.log("Evento de WhatsApp recibido:", JSON.stringify(event));
        send(res, 200, "EVENT_RECEIVED");

        for (const message of getIncomingMessages(event)) {
          processIncomingMessage(message)
            .then(() => console.log(`Mensaje procesado para ${message.from || "desconocido"}`))
            .catch((error) => console.error("No se pudo procesar el mensaje:", error.message));
        }
      } catch {
        send(res, 400, "JSON inválido");
      }
    });
    return;
  }

  send(res, 404, "No encontrado");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Webhook activo en el puerto ${PORT}`);
});
