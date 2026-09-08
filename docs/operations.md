# Operación de cola y prueba de carga

## Comprobaciones habituales

- `/api/health/live`: confirma que el proceso web está vivo.
- `/api/health/ready`: confirma PostgreSQL y Redis.
- `/api/health/details`: requiere administrador y muestra pool, cola, worker y configuración de firma.
- La sección **Operación** del panel muestra pendientes, procesando, fallidos, antigüedad y último éxito.

Los fallos definitivos no se eliminan automáticamente antes de 180 días. Un administrador puede usar **Reintentar** después de corregir la causa.

## Antes de desplegar

1. Confirma que estás en `codex/vps-postgres-migration`, no en `main`.
2. Toma un `pg_dump` verificable antes de levantar la nueva imagen.
3. Confirma que `META_APP_SECRET` existe en `.env.vps` sin imprimir su valor.
4. Ejecuta `npm test`, `npm run build`, `npx tsc --noEmit` y valida `docker compose config`.
5. Levanta `redis`, aplica la migración y confirma que `app` y `worker` están saludables.

## Carga aislada

El perfil de prueba usa una base/volúmenes separados, diez clientes ficticios y un servidor que simula n8n. No uses el nombre del proyecto ni los volúmenes de producción.

```bash
docker compose -p conecta-waba-integration --profile test up -d --build
docker compose -p conecta-waba-integration exec \
  -e LOAD_TEST_ALLOWED=true app node scripts/seed-load-test.mjs seed
LOAD_TEST_META_SECRET='secreto-de-prueba' \
  LOAD_TEST_TOTAL=1000 LOAD_TEST_CONCURRENCY=10 \
  node scripts/webhook-load-test.mjs
```

Verifica en PostgreSQL que cada trabajo único termine, que cada `wa_message_id` se reenvíe una sola vez y que los duplicados crudos estén marcados como procesados. Reinicia por separado el worker y Redis y comprueba recuperación menor a 60 segundos. Para probar una caída temporal de PostgreSQL, usa `LOAD_TEST_RETRY_503=true`, que simula la repetición de entrega de Meta.

Al terminar, elimina únicamente el entorno aislado:

```bash
docker compose -p conecta-waba-integration --profile test down --volumes
```
