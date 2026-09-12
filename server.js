const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
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
