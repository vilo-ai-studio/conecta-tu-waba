# C24 — sincronización de WhatsApp Business App

Rama `codex/c24-whatsapp-app-sync`, base `05f75b2`. **Publicado el 13 de octubre de 2026**:
runtime `589d96c`, app y worker actualizados, cliente C24 exclusivamente habilitado.

El worker acepta `smb_message_echoes/value.message_echoes`, separa cada mensaje y valida `from`
contra el número registrado de la cuenta. Cada eco conserva `raw`, cliente y cuenta; el destino
recibe `event_kind=message_echo`, `direction=outbound` y `to`. Los nombres `n8n_*` del esquema son
los campos heredados del destino HTTP; no se añadió un flujo n8n.

El reenvío de ecos exige habilitación explícita en `WHATSAPP_APP_ECHO_CLIENT_IDS` (UUIDs
exactos, sin comodín); vacío no reenvía ecos. Activar solo el cliente C24, en app y worker.
Los demás clientes conservan sus automatizaciones entrantes.

`compose.yaml` transmite esta variable tanto a `app` como a `worker`; modificar solamente
el archivo privado sin esa declaración dejaría la lista vacía dentro de los contenedores.
En la revisión del 13 de octubre se comprobó el Compose con un UUID ficticio y se repitieron
las 16 pruebas de integración, todas aprobadas. La revisión independiente no encontró otros
bloqueos de código para este alcance.

Meta verificado tras publicar primero C24 y después Connect: callback conservado;
`messages` y `smb_message_echoes` activos desde las 13:34:51 de Mérida.

La cola distingue ecos por cuenta e ids. El bloqueo usa el destinatario del eco. No se trata al
emisor de la empresa como cliente ni se ejecuta la sincronización de entrada de Chatwoot para un
eco saliente. Estados de entrega y entradas habituales conservan su ruta. Se reutilizan secreto,
logging de reenvío, timeouts y reintentos. No hay migraciones nuevas.

## Validación

- 16 tests aprobados, cero omitidos con la integración local habilitada.
- Tipos y build correctos; lint correcto en los archivos afectados.
- `tests/whatsapp-app-sync.integration.test.ts` usa PostgreSQL/Redis locales y HTTP C24 reales:
  múltiples ecos, deduplicación, autenticación y destinatario inválido; sin llamadas a Meta.
- `tests/whatsapp-app-sync.test.ts` verifica idempotencia de cola entre ids/cuentas distintos.

La integración prueba además que la lista vacía no reenvía respuestas del celular.

La integración requiere `APP_SYNC_TEST_DATABASE_URL` en loopback y base
`connect_app_sync_validation`, más `C24_APP_SYNC_TEST_URL` local. Configuración, comandos y límites
completos están en el handoff de C24 `docs/tasks/whatsapp-app-sync-handoff.md`. Sin esas variables,
el test integrado se omite y los tests unitarios siguen disponibles.

## Publicación y prueba real

C24 runtime `d17fe7e` se publicó primero. Connect app y worker usan
`conecta-waba:app-sync-589d96c`; ambos saludables, sin reinicios y con heartbeat posterior al
arranque. Configuración verificada: solo el UUID C24 recibe ecos. Respaldos restaurados en una
base aislada, cifrados y copiados al destino privado previamente autorizado; se comprobó el
descifrado sin archivo en claro. Rollback reproduce las imágenes anteriores por servicio.

A las 13:38:24 llegó un eco real, hash `b235e6572be11d9b`, destinatario terminado en 0360.
Evento `smb_message_echoes`, cuenta coincidente, `is_meta_test=false`, job completed y reenvío
200 con un mensaje aceptado. C24 conserva una sola fila `outbound/human`, fecha 13:38:23 y
texto de 192 caracteres; el navegador de Gerencia muestra **Respuesta humana** con la misma
fecha/longitud. No se exporta el contenido ni el teléfono. El eco fue de operación, no una
prueba sintética ni un envío del agente de desarrollo.

La sincronización no se limita al número de canary; ese límite corresponde a respuestas
automáticas/pruebas activas de C24. No se garantiza historial anterior. Solo se sincronizan
texto/caption y tipo; no se recuperan binarios ni se aplican ediciones/revokes. Evidencia completa
(y la consulta específica del hilo indicado por Eliam) en el handoff C24.
