# Despliegue y migración al VPS

Esta guía mueve Conecta WABA a un VPS propio con Node.js, PostgreSQL, Redis, un worker BullMQ y Caddy. La aplicación final no necesita Lovable ni un Worker de Cloudflare.

## 1. Requisitos previos

- VPS Linux con Docker Engine y Docker Compose v2.
- DNS del dominio bajo tu control.
- Puertos TCP 80 y 443 abiertos; UDP 443 es recomendable para HTTP/3.
- Una copia o cadena de conexión de lectura de la base actual.
- Valores vigentes de Meta (`META_APP_ID`, `META_APP_SECRET`, `META_CONFIGURATION_ID` y token de verificación).
- Ventana de corte acordada. No cambies todavía el webhook de Meta ni el DNS.

## 2. Preparar el servidor

Clona esta rama en una carpeta exclusiva y crea el archivo de secretos:

```bash
cp .env.vps.example .env.vps
chmod 600 .env.vps
```

Completa cada valor. `DOMAIN` debe ser sólo el host, sin `https://` ni rutas. Genera contraseñas largas y distintas para PostgreSQL, el administrador y `WHATSAPP_VERIFY_TOKEN`. Genera `DATA_ENCRYPTION_KEY` con `openssl rand -base64 32`, guárdala también fuera del VPS y no la cambies: sin esa clave no se pueden descifrar los tokens de los clientes.

Valida la configuración y levanta los servicios:

```bash
docker compose --env-file .env.vps config
docker compose --env-file .env.vps up -d --build
docker compose --env-file .env.vps ps
curl -fsS http://127.0.0.1:${APP_PORT:-3000}/api/health/live
curl -fsS http://127.0.0.1:${APP_PORT:-3000}/api/health/ready
```

El contenedor de la aplicación ejecuta automáticamente las migraciones pendientes al iniciar. Son idempotentes y quedan registradas en `schema_migrations`. Redis usa AOF para recuperarse rápido, pero PostgreSQL sigue siendo la copia durable y permite reconstruir la cola.

Antes de migrar datos reales, compara el inventario de tablas que muestra el importador con la base actual. Si la plataforma anterior contiene una tabla de negocio adicional, detén el corte y agrégala explícitamente al script; las tablas internas de autenticación del proveedor no deben copiarse.

## 3. Migrar los datos actuales

Primero crea un backup verificable de la base de origen. Después ejecuta el importador con ambas conexiones disponibles. El importador usa una transacción, respeta el orden de llaves foráneas, copia sólo columnas existentes en ambos esquemas y actualiza por `id` sin truncar el destino.

```bash
export LEGACY_DATABASE_URL='postgresql://usuario:clave@host-origen:5432/postgres?sslmode=require'
export LEGACY_DATABASE_SSL=no-verify
docker compose --env-file .env.vps run --rm \
  -e LEGACY_DATABASE_URL \
  -e LEGACY_DATABASE_SSL \
  app npm run db:import-legacy
```

El contenedor ya recibe la conexión interna al PostgreSQL nuevo. No pegues las URLs ni sus contraseñas en tickets, commits o capturas.

No se migran los usuarios de autenticación del proveedor anterior. Crea el administrador local:

```bash
docker compose --env-file .env.vps --profile tools run --rm admin
```

La salida del importador muestra por tabla el total de origen y el total final. Conserva esa evidencia y verifica al menos:

```sql
SELECT count(*) FROM clients;
SELECT count(*) FROM whatsapp_accounts;
SELECT count(*) FROM client_integrations;
SELECT count(*) FROM processed_whatsapp_messages;
```

## 4. Pruebas antes del corte

Usa un dominio temporal o una entrada local de hosts para probar el VPS sin afectar producción.

1. `GET /api/health/live` responde `200`; `GET /api/health/ready` confirma PostgreSQL y Redis.
2. El servicio `worker` aparece saludable y su heartbeat se actualiza cada diez segundos.
3. El administrador puede iniciar y cerrar sesión y abrir la sección **Operación**.
4. El panel muestra los clientes, cuentas y métricas de trabajos pendientes/fallidos.
5. Se puede crear y validar un onboarding de prueba.
6. La verificación `GET` del webhook devuelve exactamente el challenge con el token correcto y `403` con uno incorrecto.
7. Un `POST` con firma HMAC válida se guarda; firma inválida devuelve `401` y más de 1 MB devuelve `413`.
8. Un payload controlado se asocia al cliente correcto por `phone_number_id` y aparece en los logs.
9. En ambiente de prueba, n8n y Chatwoot reciben un mensaje y no reciben los de otro cliente.
10. El envío saliente usa la cuenta del cliente correcto.

Los puntos 9 y 10 requieren credenciales y sistemas externos reales; no se consideran aprobados sólo con una prueba local.

## 5. Corte con interrupción mínima

1. Pon en pausa cambios de clientes/configuración en la plataforma anterior.
2. Haz un backup final e importa nuevamente los datos. El importador hace upsert por `id`.
3. Verifica los conteos y ejecuta la lista de pruebas.
4. Apunta el DNS del dominio al VPS y espera a que Caddy emita el certificado.
5. En Meta, confirma que la Callback URL sea `https://<DOMAIN>/api/public/whatsapp/webhook` y conserva el mismo verify token.
6. Envía una prueba controlada por cada integración crítica.
7. Mantén la infraestructura anterior disponible, sin destruirla, durante la ventana de observación acordada.

El Worker temporal deja de ser necesario cuando los clientes y Meta apuntan al dominio del VPS. Su retiro debe hacerse después de confirmar tráfico real en el VPS, no antes.

## 6. Rollback

Si falla una prueba crítica durante el corte:

1. Restaura el DNS o Callback URL hacia la ruta anterior.
2. Confirma que vuelven a entrar webhooks en la infraestructura anterior.
3. Conserva logs y no elimines la base nueva; sirven para reconciliar eventos.
4. Corrige el problema y repite la importación incremental antes de un nuevo intento.

No ejecutes `docker compose down -v` en producción: `-v` elimina la base persistente.

## 7. Backups y actualización

Programa un `pg_dump` diario hacia almacenamiento fuera del VPS y conserva al menos una copia cifrada externa. Prueba periódicamente la restauración en una base separada. Redis no necesita respaldo histórico: su volumen AOF acelera la recuperación y el outbox PostgreSQL reconstruye trabajos faltantes.

Para actualizar sin reescribir historial:

```bash
git pull --ff-only
docker compose --env-file .env.vps up -d --build
docker compose --env-file .env.vps ps
curl -fsS https://${DOMAIN}/api/health
```

Antes de cada actualización toma un backup. Las migraciones se aplican al iniciar la nueva imagen.

La prueba de carga aislada usa el perfil `test`; nunca lo levantes en producción ni ejecutes el sembrado sin `LOAD_TEST_ALLOWED=true` en una base desechable. El procedimiento y los criterios están en [operations.md](operations.md).
