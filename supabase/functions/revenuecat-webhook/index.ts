import { createClient } from 'npm:@supabase/supabase-js@2.49.1';
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/http.ts';
import {
  constantTimeEqual,
  parseRevenueCatPayload,
  verifyRevenueCatSignature,
} from '../_shared/revenuecat.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  const expectedAuthorization = Deno.env.get('REVENUECAT_WEBHOOK_AUTHORIZATION');
  if (!expectedAuthorization) {
    console.error('RevenueCat webhook authorization is not configured');
    return errorResponse(503, 'configuration_error', 'Webhook unavailable');
  }
  if (!constantTimeEqual(req.headers.get('authorization') ?? '', expectedAuthorization)) {
    return errorResponse(401, 'auth_required', 'Invalid webhook authorization');
  }

  const rawBody = await req.text();
  const signingSecret = Deno.env.get('REVENUECAT_WEBHOOK_SIGNING_SECRET');
  if (signingSecret && !(await verifyRevenueCatSignature(
    rawBody,
    req.headers.get('x-revenuecat-webhook-signature'),
    signingSecret,
  ))) {
    return errorResponse(401, 'auth_required', 'Invalid webhook signature');
  }
  const payload = parseRevenueCatPayload(rawBody);
  if (!payload) return errorResponse(400, 'validation_failed', 'Invalid webhook payload');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    console.error('Supabase service configuration is missing');
    return errorResponse(503, 'configuration_error', 'Webhook unavailable');
  }
  const event = payload.event;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc('ingest_revenuecat_study_purchase', {
    p_event_id: event.id,
    p_api_version: payload.api_version,
    p_event_type: event.type,
    p_app_id: event.app_id ?? null,
    p_product_id: event.product_id ?? null,
    p_app_user_id: event.app_user_id ?? null,
    p_original_app_user_id: event.original_app_user_id ?? null,
    p_aliases: event.aliases ?? [],
    p_transaction_id: event.transaction_id ?? null,
    p_original_transaction_id: event.original_transaction_id ?? null,
    p_store: event.store ?? null,
    p_environment: event.environment ?? null,
    p_purchased_at_ms: event.purchased_at_ms ?? null,
    p_event_timestamp_ms: event.event_timestamp_ms,
    p_currency: event.currency ?? null,
    p_price: event.price ?? null,
    p_payload: payload,
  });
  if (error) {
    console.error('RevenueCat ingestion failed', { eventId: event.id, code: error.code });
    return errorResponse(500, 'processing_failed', 'Webhook processing failed');
  }
  console.log(JSON.stringify({
    eventId: event.id,
    type: event.type,
    status: data?.status,
    duplicate: data?.duplicate,
  }));
  return jsonResponse({ received: true, status: data?.status, duplicate: data?.duplicate });
});
