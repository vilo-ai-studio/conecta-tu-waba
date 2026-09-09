export function isMetaSubscriptionConfirmed(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { success?: unknown }).success === true;
}
