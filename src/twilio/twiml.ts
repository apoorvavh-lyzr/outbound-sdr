/** XML entity escaping for attribute values and text nodes. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface StreamTwiMLOptions {
  streamUrl: string;
  callId: string;
  /** Extra <Parameter> entries. Keep these free of PII. */
  parameters?: Record<string, string>;
}

/**
 * Inline TwiML connecting the call to our bidirectional Media Stream.
 *
 * Context travels as <Parameter> elements rather than query string: the WSS URL
 * appears in Twilio logs, so lead data must not be embedded in it.
 */
export function buildStreamTwiML(options: StreamTwiMLOptions): string {
  const params = { callId: options.callId, ...(options.parameters ?? {}) };
  const parameterXml = Object.entries(params)
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(String(value))}"/>`)
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>` +
    `<Stream url="${escapeXml(options.streamUrl)}">${parameterXml}</Stream>` +
    `</Connect>` +
    `</Response>`
  );
}
