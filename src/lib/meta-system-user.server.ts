/**
 * Credencial operacional de Meta para el router.
 *
 * El onboarding del cliente identifica y comparte activos, pero los envíos y
 * operaciones administrativas se ejecutan siempre con el System User de Búho.
 * No se debe persistir un access token OAuth del cliente para esas operaciones.
 */
export class MetaSystemUserTokenMissingError extends Error {
  constructor() {
    super("Falta META_SYSTEM_USER_ACCESS_TOKEN en el servidor.");
    this.name = "MetaSystemUserTokenMissingError";
  }
}

export function getMetaSystemUserToken(): string {
  const token = process.env.META_SYSTEM_USER_ACCESS_TOKEN?.trim();
  if (!token) throw new MetaSystemUserTokenMissingError();
  return token;
}

export function metaSystemUserHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer ${getMetaSystemUserToken()}`);
  return headers;
}

export function metaAuthFailureMessage(
  status: number,
  payload: { error?: { code?: number; message?: string } } | null | undefined,
): string | null {
  if (status === 401 || payload?.error?.code === 190) {
    return "La credencial técnica de Meta fue invalidada. Un administrador debe generar y cargar un nuevo System User Token.";
  }
  if (payload?.error?.code === 10 || payload?.error?.code === 100 || payload?.error?.code === 200) {
    return "El System User no tiene acceso a este activo de WhatsApp. Revisa la asignación del WABA y sus permisos en Meta Business.";
  }
  return null;
}

export function isMetaSystemUserTokenConfigured(): boolean {
  return Boolean(process.env.META_SYSTEM_USER_ACCESS_TOKEN?.trim());
}
