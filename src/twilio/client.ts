import twilio from "twilio";
import { UpstreamError } from "../utils/errors.js";
import { getLogger } from "../utils/logging.js";

export interface CreateCallInput {
  to: string;
  from: string;
  twiml: string;
  statusCallbackUrl: string;
  timeoutSeconds: number;
}

export interface CreatedCall {
  sid: string;
  status: string;
}

export interface TwilioCallClient {
  createCall(input: CreateCallInput): Promise<CreatedCall>;
}

export class RealTwilioClient implements TwilioCallClient {
  private readonly client: twilio.Twilio;
  private readonly log = getLogger().child({ component: "twilio-client" });

  constructor(accountSid: string, authToken: string) {
    this.client = twilio(accountSid, authToken);
  }

  async createCall(input: CreateCallInput): Promise<CreatedCall> {
    try {
      const call = await this.client.calls.create({
        to: input.to,
        from: input.from,
        twiml: input.twiml,
        statusCallback: input.statusCallbackUrl,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        timeout: input.timeoutSeconds,
      });
      return { sid: call.sid, status: call.status };
    } catch (err) {
      const code = (err as { code?: number }).code;
      const status = (err as { status?: number }).status;
      this.log.error({ event: "twilio_call_failed", twilioCode: code, status }, "Twilio call creation failed");
      throw new UpstreamError(
        "twilio_call_failed",
        `Twilio rejected the call${code ? ` (code ${code})` : ""}`,
        status && status < 500 ? 422 : 502,
        { twilioCode: code },
      );
    }
  }
}

/** Deterministic stand-in used when MOCK_EXTERNAL_SERVICES=true. */
export class MockTwilioClient implements TwilioCallClient {
  readonly created: CreateCallInput[] = [];

  async createCall(input: CreateCallInput): Promise<CreatedCall> {
    this.created.push(input);
    const suffix = String(this.created.length).padStart(4, "0");
    return { sid: `CAmock00000000000000000000000${suffix}`, status: "queued" };
  }
}
