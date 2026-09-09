import type { Logger } from "pino";
import { WebSocket, type RawData, type WebSocketServer } from "ws";
import type { Env } from "../config/env.js";
import type { CallService } from "../calls/service.js";
import type { CallRepository } from "../db/repository.js";
import { AudioBridge } from "../audio/bridge.js";
import type { LyzrClient } from "../lyzr/client.js";
import { CAPTURE_SAMPLE_RATE, type LiveKitSession } from "../lyzr/schemas.js";
import { LiveKitRoomBridge } from "../livekit/roomBridge.js";
import { parseTwilioFrame } from "../twilio/schemas.js";
import { verifyStreamToken } from "../twilio/validation.js";
import { toAppError } from "../utils/errors.js";

export interface MediaGatewayDeps {
  env: Env;
  service: CallService;
  repository: CallRepository;
  lyzr: LyzrClient;
  logger: Logger;
  /** Injected in tests/mock mode so no real room is joined. */
  connectAgent?: (session: LiveKitSession, callId: string) => Promise<AgentConnection>;
}

/** The agent-side half of a call, so the room can be swapped out in tests. */
export interface AgentConnection {
  capture(pcm16le: Buffer): void;
  isReady(): boolean;
  close(reason?: string): Promise<void>;
}

/** One live Twilio <-> Lyzr conversation. */
class MediaSession {
  private bridge: AudioBridge | undefined;
  private agent: AgentConnection | undefined;
  private sessionId: string | undefined;
  private closing = false;
  private callId: string | undefined;
  private log: Logger;

  constructor(
    private readonly twilioSocket: WebSocket,
    private readonly deps: MediaGatewayDeps,
  ) {
    this.log = deps.logger.child({ component: "twilio-media" });
  }

  attach(): void {
    this.twilioSocket.on("message", (data) => {
      void this.onTwilioMessage(data).catch((err) => this.fail(err));
    });
    this.twilioSocket.on("close", () => void this.close("twilio_closed"));
    this.twilioSocket.on("error", (err) => this.fail(err));
  }

  private async onTwilioMessage(data: RawData): Promise<void> {
    const frame = parseTwilioFrame(data.toString());
    if (!frame) return; // malformed frames are ignored, never fatal

    switch (frame.event) {
      case "connected":
        this.log.debug({ event: "twilio_ws_connected" }, "Twilio media socket connected");
        return;
      case "start":
        return this.onStart(frame.start, frame.streamSid);
      case "media":
        if (frame.media?.payload) this.bridge?.handleTwilioAudio(frame.media.payload);
        return;
      case "mark":
        this.log.debug({ event: "twilio_mark", name: frame.mark?.name }, "mark acknowledged");
        return;
      case "stop":
        await this.close("twilio_stop");
        return;
      default:
        return;
    }
  }

  private async onStart(start: unknown, frameStreamSid: string | undefined): Promise<void> {
    const startObj = (start ?? {}) as {
      streamSid?: string;
      callSid?: string;
      customParameters?: Record<string, string>;
    };

    const streamSid = startObj.streamSid ?? frameStreamSid;
    const params = startObj.customParameters ?? {};
    const callId = params.callId;

    if (!streamSid || !callId) {
      this.log.warn({ event: "twilio_stream_rejected" }, "stream start missing streamSid or callId");
      await this.close("missing_identifiers");
      return;
    }

    // Twilio does not sign the WS upgrade, so the per-call HMAC minted into the
    // TwiML is what authenticates this stream.
    const secret =
      this.deps.env.SUPERFLOW_SHARED_SECRET ??
      this.deps.env.TWILIO_AUTH_TOKEN ??
      "insecure-development-secret";
    if (!verifyStreamToken(callId, params.token, secret)) {
      this.log.warn({ event: "twilio_stream_rejected", callId }, "stream start failed token verification");
      await this.close("invalid_stream_token");
      return;
    }

    const call = await this.deps.repository.findById(callId);
    if (!call) {
      this.log.warn({ event: "twilio_stream_rejected", callId }, "unknown callId on stream start");
      await this.close("unknown_call");
      return;
    }

    this.callId = callId;
    this.log = this.log.child({ callId, streamSid, twilioCallSid: startObj.callSid ?? call.twilio_call_sid });
    this.log.info({ event: "twilio_stream_started" }, "media stream started");

    await this.deps.repository.update(callId, {
      twilio_stream_sid: streamSid,
      ...(startObj.callSid && !call.twilio_call_sid ? { twilio_call_sid: startObj.callSid } : {}),
    });
    await this.deps.service.markStreamStatus(callId, "stream_connecting");

    const meta = (call.metadata ?? {}) as Record<string, unknown>;
    // A clone (when enabled) wins; otherwise this is the reused saved agent.
    const agentId =
      call.lyzr_call_agent_id ?? (typeof meta.agentId === "string" ? meta.agentId : call.lyzr_base_agent_id);
    if (!agentId) {
      this.fail(new Error("Call has no prepared Lyzr agent"));
      return;
    }

    const sessionConfig =
      meta.sessionConfig && typeof meta.sessionConfig === "object"
        ? (meta.sessionConfig as Record<string, unknown>)
        : undefined;

    // The bridge exists BEFORE the room is joined so caller audio arriving
    // during connection is buffered rather than lost.
    this.bridge = new AudioBridge({
      streamSid,
      captureSampleRate: CAPTURE_SAMPLE_RATE,
      preconnectBufferMs: this.deps.env.AUDIO_PRECONNECT_BUFFER_MS,
      transport: {
        sendToAgent: (pcm) => this.agent?.capture(pcm),
        sendToTwilio: (payload) => {
          if (this.twilioSocket.readyState === WebSocket.OPEN) this.twilioSocket.send(payload);
        },
        isAgentReady: () => this.agent?.isReady() ?? false,
      },
      logger: this.log,
    });

    await this.joinAgentRoom(agentId, callId, sessionConfig);
  }

  private async joinAgentRoom(
    agentId: string,
    callId: string,
    sessionConfig?: Record<string, unknown>,
  ): Promise<void> {
    const session = await this.deps.lyzr.startVoiceSession(agentId, `twilio-${callId}`, sessionConfig);
    this.sessionId = session.sessionId;

    this.log.info(
      {
        event: "lyzr_session_created",
        lyzrSessionId: session.sessionId,
        roomName: session.roomName,
        agentDispatched: session.agentDispatched,
      },
      "voice session created",
    );
    await this.deps.repository.update(callId, { lyzr_session_id: session.sessionId });

    if (this.deps.connectAgent) {
      this.agent = await this.deps.connectAgent(session, callId);
      this.bridge?.markAgentReady();
      await this.deps.service.markStreamStatus(callId, "streaming");
      return;
    }

    const room = new LiveKitRoomBridge(
      session,
      {
        onAgentAudio: (pcm, sampleRate) => this.bridge?.handleAgentAudio(pcm, sampleRate),
        onAgentReady: () => {
          this.bridge?.markAgentReady();
          void this.deps.service.markStreamStatus(callId, "streaming");
        },
        onClosed: (reason) => void this.close(`livekit_${reason}`),
        onError: (err) => this.fail(err),
      },
      this.log,
    );

    this.agent = {
      capture: (pcm) => room.capture(pcm),
      isReady: () => room.isReady,
      close: (reason) => room.close(reason),
    };

    await room.connect();
  }

  private fail(err: unknown): void {
    const appError = toAppError(err);
    this.log.error({ event: "bridge_error", code: appError.code }, appError.message);
    if (this.callId) void this.deps.service.recordBridgeFailure(this.callId, appError).catch(() => undefined);
    void this.close("error");
  }

  /** Tears both sides down exactly once. */
  private async close(reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    this.bridge?.close();
    this.bridge = undefined;

    await this.agent?.close(reason).catch(() => undefined);
    this.agent = undefined;

    // Let Lyzr tear down its side of the room. Best-effort by design.
    if (this.sessionId) {
      void this.deps.lyzr.endVoiceSession(this.sessionId).catch(() => undefined);
      this.sessionId = undefined;
    }

    this.twilioSocket.removeAllListeners("message");
    if (
      this.twilioSocket.readyState === WebSocket.OPEN ||
      this.twilioSocket.readyState === WebSocket.CONNECTING
    ) {
      try {
        this.twilioSocket.close();
      } catch {
        this.twilioSocket.terminate();
      }
    }

    this.log.info({ event: "media_session_closed", reason }, "media session closed");
  }
}

export function registerMediaGateway(wss: WebSocketServer, deps: MediaGatewayDeps): void {
  wss.on("connection", (socket: WebSocket) => {
    new MediaSession(socket, deps).attach();
  });
}
