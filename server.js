const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

const WELCOME_MESSAGE = [
  "¡Hola! 👋 Gracias por escribir a Mandados Chevita.",
  "",
  "Para solicitar un mandado, envíanos:",
  "1. Lugar de compra o recogida",
  "2. Dirección de entrega",
  "3. Qué necesitas",
  "",
  "En breve uno de nuestros motorizados te atenderá."
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
          if (!message.from) continue;

          sendWhatsAppMessage(message.from, WELCOME_MESSAGE)
            .then(() => console.log(`Respuesta automática enviada a ${message.from}`))
            .catch((error) => console.error("No se pudo responder:", error.message));
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
