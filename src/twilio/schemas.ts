import { z } from "zod";

/** Twilio Media Stream frames. Only the fields we act on are required. */

export const twilioStartSchema = z
  .object({
    streamSid: z.string().optional(),
    callSid: z.string().optional(),
    customParameters: z.record(z.string()).optional(),
    mediaFormat: z
      .object({
        encoding: z.string().optional(),
        sampleRate: z.number().optional(),
        channels: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const twilioMediaFrameSchema = z
  .object({
    event: z.string(),
    streamSid: z.string().optional(),
    start: twilioStartSchema.optional(),
    media: z
      .object({
        payload: z.string(),
        track: z.string().optional(),
        chunk: z.string().optional(),
        timestamp: z.string().optional(),
      })
      .passthrough()
      .optional(),
    mark: z.object({ name: z.string() }).passthrough().optional(),
  })
  .passthrough();

export type TwilioMediaFrame = z.infer<typeof twilioMediaFrameSchema>;

/** Parses a Media Stream frame; returns null rather than throwing. */
export function parseTwilioFrame(raw: string): TwilioMediaFrame | null {
  try {
    const parsed = twilioMediaFrameSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Twilio status callback (form-encoded). */
export const twilioStatusCallbackSchema = z
  .object({
    CallSid: z.string().min(1),
    CallStatus: z.string().min(1),
    CallDuration: z.string().optional(),
    Timestamp: z.string().optional(),
    ErrorCode: z.string().optional(),
    ErrorMessage: z.string().optional(),
  })
  .passthrough();

export type TwilioStatusCallback = z.infer<typeof twilioStatusCallbackSchema>;
