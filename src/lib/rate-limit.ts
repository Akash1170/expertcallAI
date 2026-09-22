export function retryAfterSeconds(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { headers?: Headers; retryAfter?: number };
  if (candidate.retryAfter && Number.isFinite(candidate.retryAfter)) return Math.max(1, Math.ceil(candidate.retryAfter));
  const retryAfter = candidate.headers?.get('retry-after');
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds));
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(1, Math.ceil((date - Date.now()) / 1000));
}

export function isRateLimit(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: number; statusCode?: number; error?: { code?: string } };
  return candidate.status === 429 || candidate.statusCode === 429 || candidate.error?.code === 'too_many_requests';
}
