import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  constantTimeEqual,
  parseRevenueCatPayload,
  verifyRevenueCatSignature,
} from './revenuecat.ts';

Deno.test('parses valid payloads and rejects malformed payloads', () => {
  const valid = JSON.stringify({ api_version: '1.0', event: {
    id: 'evt-1', type: 'NON_RENEWING_PURCHASE', event_timestamp_ms: 123,
  } });
  assertEquals(parseRevenueCatPayload(valid)?.event.id, 'evt-1');
  assertEquals(parseRevenueCatPayload('{'), null);
  assertEquals(parseRevenueCatPayload(JSON.stringify({ api_version: '1.0', event: {} })), null);
});

Deno.test('compares authorization values exactly', () => {
  assert(constantTimeEqual('Bearer secret', 'Bearer secret'));
  assert(!constantTimeEqual('Bearer secret', 'Bearer Secret'));
  assert(!constantTimeEqual('Bearer secret', 'Bearer secret-extra'));
});

Deno.test('verifies HMAC over timestamp and the unchanged raw body', async () => {
  const body = '{"api_version":"1.0","event":{"id":"evt-1"}}';
  const secret = 'signing-secret';
  const timestamp = 1_700_000_000;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`${timestamp}.${body}`));
  const digest = [...new Uint8Array(signed)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const header = `t=${timestamp},v1=${digest}`;
  assert(await verifyRevenueCatSignature(body, header, secret, timestamp * 1000));
  assert(!await verifyRevenueCatSignature(`${body} `, header, secret, timestamp * 1000));
  assert(!await verifyRevenueCatSignature(body, header, secret, (timestamp + 301) * 1000));
  assert(!await verifyRevenueCatSignature(body, `t=${timestamp},v1=invalid`, secret, timestamp * 1000));
});
