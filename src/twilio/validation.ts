import { createHmac, timingSafeEqual } from "node:crypto";
import twilio from "twilio";

/** Constant-time string comparison that tolerates unequal lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still hash both sides so the comparison cost does not leak the length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Rebuilds the public URL Twilio signed.
 *
 * Railway terminates TLS at its edge, so the request Fastify sees is plain HTTP
 * on an internal host. Signature validation must use the externally visible
 * URL, which we take from PUBLIC_BASE_URL rather than trusting forwarded
 * headers an attacker could set.
 */
export function reconstructWebhookUrl(publicBaseUrl: string, path: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface TwilioSignatureInput {
  authToken: string;
  signature: string | undefined;
  url: string;
  params: Record<string, unknown>;
}

/** Validates X-Twilio-Signature for a form-encoded webhook. */
export function validateTwilioSignature({ authToken, signature, url, params }: TwilioSignatureInput): boolean {
  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, url, params as Record<string, string>);
}

/**
 * Twilio does not sign the WebSocket upgrade request for Media Streams, so
 * there is no signature to verify on /twilio-media.
 *
 * Instead we mint a short HMAC over the callId, deliver it through the TwiML
 * <Parameter> list (which only Twilio ever sees, over TLS), and require it on
 * stream start. That gives the upgrade an authenticated, per-call credential
 * without depending on undocumented Twilio behaviour.
 */
export function signStreamToken(callId: string, secret: string): string {
  return createHmac("sha256", secret).update(callId).digest("base64url").slice(0, 32);
}

export function verifyStreamToken(callId: string, token: string | undefined, secret: string): boolean {
  if (!token) return false;
  return safeEqual(signStreamToken(callId, secret), token);
}
