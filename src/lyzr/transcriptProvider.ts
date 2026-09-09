import type { Env } from "../config/env.js";
import { withTimeout } from "../utils/timeout.js";

export interface TranscriptResult {
  available: boolean;
  session_id?: string | null;
  transcript?: string | null;
  messages?: unknown[];
  reason?: string;
}

export interface TranscriptProvider {
  fetch(sessionId: string | null): Promise<TranscriptResult>;
}

/**
 * Used when no transcript endpoint has been verified.
 *
 * Lyzr does not publish a transcript retrieval API for external voice sessions,
 * and inventing one would produce confident-looking failures. Reporting
 * "not configured" is the honest answer, and never blocks calling.
 */
export class UnconfiguredTranscriptProvider implements TranscriptProvider {
  async fetch(sessionId: string | null): Promise<TranscriptResult> {
    return {
      available: false,
      session_id: sessionId,
      reason:
        "Transcript provider is not configured. Set LYZR_TRANSCRIPT_URL_TEMPLATE once a transcript API is confirmed.",
    };
  }
}

/**
 * Fetches transcripts from an operator-supplied URL template containing
 * `{sessionId}`. This is the escape hatch for using a transcript API we could
 * not verify from public documentation.
 */
export class TemplateTranscriptProvider implements TranscriptProvider {
  constructor(
    private readonly template: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs = 15_000,
  ) {}

  async fetch(sessionId: string | null): Promise<TranscriptResult> {
    if (!sessionId) {
      return { available: false, session_id: null, reason: "Call has no Lyzr session id" };
    }

    const url = this.template.replace(/\{sessionId\}/g, encodeURIComponent(sessionId));

    try {
      return await withTimeout(this.timeoutMs, "transcript fetch", async (signal) => {
        const response = await fetch(url, {
          signal,
          headers: this.apiKey ? { "x-api-key": this.apiKey } : {},
        });

        if (!response.ok) {
          return {
            available: false,
            session_id: sessionId,
            reason: `Transcript endpoint returned HTTP ${response.status}`,
          };
        }

        const body = (await response.json()) as Record<string, unknown>;
        const messages = Array.isArray(body.messages) ? body.messages : undefined;
        const transcript =
          typeof body.transcript === "string"
            ? body.transcript
            : typeof body.text === "string"
              ? body.text
              : null;

        return {
          available: true,
          session_id: sessionId,
          transcript,
          ...(messages ? { messages } : {}),
        };
      });
    } catch (err) {
      return {
        available: false,
        session_id: sessionId,
        reason: err instanceof Error ? err.message : "Transcript fetch failed",
      };
    }
  }
}

export function createTranscriptProvider(env: Env): TranscriptProvider {
  if (env.LYZR_TRANSCRIPT_URL_TEMPLATE) {
    return new TemplateTranscriptProvider(env.LYZR_TRANSCRIPT_URL_TEMPLATE, env.LYZR_API_KEY);
  }
  return new UnconfiguredTranscriptProvider();
}
