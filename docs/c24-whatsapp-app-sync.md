# C24 — sincronización de WhatsApp Business App

Rama `codex/c24-whatsapp-app-sync`, base `05f75b2`. Lista para revisión local; no publicada.

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

Consulta de Meta del 13 de octubre: la cuenta C24 está suscrita a la aplicación del router;
el callback de la aplicación es el de Connect y sus campos activos contienen únicamente
`messages`. Falta habilitar `smb_message_echoes` después de actualizar ambos servicios.

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

## Publicación pendiente

Revisar ambos repositorios. Verificar suscripción efectiva de Meta a `smb_message_echoes` y que
la cuenta use coexistencia. Tras autorización y respaldo, publicar tanto app como worker de
Connect después de C24; habilitar la suscripción Meta al final para evitar que un receptor
anterior acepte el HTTP sin conservar el mensaje. Un worker con código anterior seguirá rechazando ecos. Probar un envío
real desde el celular y verificar el mismo id en la bandeja. No se garantiza historial anterior.
Solo se sincronizan texto/caption y tipo; no se recuperan binarios ni se aplican ediciones/revokes.
