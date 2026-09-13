export type RevenueCatEvent = {
  id: string; type: string; app_id?: string | null; product_id?: string | null;
  app_user_id?: string | null; original_app_user_id?: string | null;
  aliases?: string[] | null; transaction_id?: string | null;
  original_transaction_id?: string | null; store?: string | null;
  environment?: string | null; purchased_at_ms?: number | null;
  event_timestamp_ms: number; currency?: string | null; price?: number | null;
};
export type RevenueCatPayload = { api_version: string; event: RevenueCatEvent };

export function parseRevenueCatPayload(raw: string): RevenueCatPayload | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const root = value as Record<string, unknown>;
  const event = root.event;
  if (typeof root.api_version !== 'string' || !event || typeof event !== 'object') return null;
  const row = event as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id || typeof row.type !== 'string' ||
    typeof row.event_timestamp_ms !== 'number' || !Number.isFinite(row.event_timestamp_ms)) return null;
  if (row.aliases != null && (!Array.isArray(row.aliases) ||
    row.aliases.some((v) => typeof v !== 'string'))) return null;
  return value as RevenueCatPayload;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (left[i % Math.max(left.length, 1)] ?? 0) ^
      (right[i % Math.max(right.length, 1)] ?? 0);
  }
  return mismatch === 0;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyRevenueCatSignature(
  rawBody: string, header: string | null, secret: string,
  nowMs = Date.now(), toleranceMs = 5 * 60 * 1000,
): Promise<boolean> {
  if (!header) return false;
  const fields = Object.fromEntries(header.split(',').map((part) => {
    const [key, ...value] = part.trim().split('=');
    return [key, value.join('=')];
  }));
  const timestamp = Number(fields.t);
  const supplied = fields.v1;
  if (!Number.isInteger(timestamp) || !supplied || !/^[0-9a-fA-F]{64}$/.test(supplied) ||
    Math.abs(nowMs - timestamp * 1000) > toleranceMs) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`));
  return constantTimeEqual(hex(digest), supplied.toLowerCase());
}
