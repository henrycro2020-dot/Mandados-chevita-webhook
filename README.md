# Mandados Chevita — webhook de WhatsApp

Servicio mínimo para verificar y recibir eventos de WhatsApp Cloud API.

## Rutas

- `GET /`: comprobación de salud.
- `GET /webhook`: verificación solicitada por Meta.
- `POST /webhook`: recepción de eventos de WhatsApp.

## Variable necesaria

- `WHATSAPP_VERIFY_TOKEN`: token privado elegido para verificar el webhook en Meta.

No guardes tokens ni claves directamente en este repositorio.
