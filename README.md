# Conecta WABA — router multi-cliente

Router y panel de administración para operar múltiples clientes de WhatsApp Business Platform. Recibe los webhooks de Meta, identifica al cliente por `phone_number_id`, conserva trazabilidad, deduplica mensajes y los dirige a la integración de n8n y/o Chatwoot configurada para ese cliente.

Esta rama funciona sobre infraestructura propia. No requiere Lovable, Supabase ni Cloudflare en tiempo de ejecución.

## Arquitectura

- Aplicación: TanStack Start sobre Node.js 22.
- Base de datos: PostgreSQL 17 directo mediante `pg`.
- Sesiones: cookie `HttpOnly` y tokens aleatorios almacenados como hash SHA-256.
- Secretos operativos: AES-256-GCM con una clave externa `DATA_ENCRYPTION_KEY`.
- Entrada HTTPS: Caddy con certificados automáticos.
- Despliegue: Docker Compose con servicios `app`, `postgres` y `caddy`.
- Actualización del panel: polling corto; no depende de Supabase Realtime.

## Flujo principal

1. El administrador inicia sesión en `/auth` y crea un cliente.
2. Genera un enlace único de onboarding.
3. El cliente completa Meta Embedded Signup en `/connect/:token`.
4. El backend intercambia el código, almacena la cuenta y suscribe el WABA.
5. Meta entrega los eventos a `/api/public/whatsapp/webhook`.
6. El router encuentra al cliente y entrega el mensaje a su n8n o lo sincroniza con Chatwoot.

## Desarrollo local

Requisitos: Node.js 22 y un PostgreSQL accesible.

```bash
npm ci
export DATABASE_URL='postgresql://usuario:password@127.0.0.1:5432/conecta_waba'
export DATABASE_SSL=disable
npm run db:migrate
npm run dev
```

Para crear o restablecer el administrador:

```bash
export ADMIN_EMAIL='admin@tu-dominio.com'
export ADMIN_PASSWORD='una-clave-de-al-menos-12-caracteres'
export ADMIN_NAME='Administrador'
npm run admin:create
```

## Despliegue en VPS

La guía completa, incluida la migración de datos, validación, corte de tráfico y rollback, está en [docs/vps-deployment.md](docs/vps-deployment.md).

Inicio resumido:

```bash
cp .env.vps.example .env.vps
# Completar todos los valores reales en .env.vps
docker compose --env-file .env.vps up -d --build
docker compose --env-file .env.vps --profile tools run --rm admin
curl -fsS https://tu-dominio/api/health
```

## Comandos de verificación

```bash
npx tsc --noEmit
npm run build
docker compose --env-file .env.vps config
```

## Seguridad y operación

- `.env` y `.env.vps` no se versionan.
- PostgreSQL sólo existe dentro de la red privada de Compose; no publica el puerto 5432.
- La app publica su puerto únicamente en loopback y Caddy es la entrada pública.
- `META_APP_SECRET`, los tokens de WhatsApp y secretos de n8n/Chatwoot nunca se envían al navegador; los secretos por cliente se cifran en PostgreSQL.
- Configura backups diarios y prueba la restauración antes del corte definitivo.
- El esquema autónomo y sus migraciones viven en `database/migrations/`.

## Documentación

- [Contrato de endpoints](docs/api-endpoints.md)
- [Despliegue y migración al VPS](docs/vps-deployment.md)
- [Pruebas manuales de Chatwoot](docs/chatwoot-manual-tests.md)
