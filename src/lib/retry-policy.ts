export const RETRY_DELAYS_MS = [
  5_000, 30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000,
] as const;

export function retryDelayMs(failedAttempt: number, random = Math.random): number {
  const base =
    RETRY_DELAYS_MS[Math.min(Math.max(failedAttempt - 1, 0), RETRY_DELAYS_MS.length - 1)];
  return base + Math.round(base * random() * 0.2);
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
