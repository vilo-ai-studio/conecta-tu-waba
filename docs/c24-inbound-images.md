# Imágenes entrantes para la bandeja C24

Cambio preparado en `codex/c24-inbound-images`, base publicada `15cbf70`. No activa Chatwoot,
envíos, forwarding ni cambia secretos. C24 solicita una imagen con `POST
/api/public/whatsapp/download-image`, encabezado `X-N8N-Webhook-Secret` y JSON
`{ "client_id": "UUID", "inbound_message_id": "wamid.…" }`.

El router valida el secreto descifrado del cliente y limita solicitudes. Busca únicamente un
evento entrante de imagen del mismo cliente y cuenta conectada; verifica el mensaje y número
de cuenta dentro del payload. No acepta URLs ni media IDs suministrados por el consumidor.
El System User Token permanece en Connect. Solo descarga desde Graph y dominios CDN de Meta
por HTTPS sin redirecciones, valida firma JPEG/PNG/WebP y limita a 10 MB. Nunca devuelve
token, URL del proveedor, payload completo ni detalles de error sensibles. Respuesta binaria
privada sin caché; 401/400/404/503 en fallos. Un archivo eliminado por Meta puede ser irrecuperable.

Publicación: revisar junto a `feature/chat-image-preview` de C24; autorizar publicación del
endpoint de Connect primero y luego C24. La ruta es aditiva y no requiere migración de Connect.
Rollback: imagen anterior de aplicación, conservando base de datos y configuración.
