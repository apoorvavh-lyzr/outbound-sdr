import type { Logger } from "pino";
import { decodeMuLaw, encodeMuLaw } from "./mulaw.js";
import { createResampler, type AudioResampler } from "./resampler.js";

export const TWILIO_SAMPLE_RATE = 8000;
/** 20 ms of 8 kHz mu-law = 160 bytes, Twilio's native frame size. */
export const TWILIO_FRAME_BYTES = 160;

export interface BridgeTransport {
  /** Hands PCM16 LE (at the capture rate) to the agent side. */
  sendToAgent(pcm16le: Buffer): void;
  /** Sends one JSON string to Twilio. */
  sendToTwilio(payload: string): void;
  /** True once the agent side can accept audio. */
  isAgentReady(): boolean;
}

export interface AudioBridgeOptions {
  streamSid: string;
  /** Rate we publish the prospect's audio at. */
  captureSampleRate: number;
  /** Max milliseconds of caller audio held while the agent side connects. */
  preconnectBufferMs: number;
  transport: BridgeTransport;
  logger: Logger;
}

export interface BridgeStats {
  twilioFramesIn: number;
  agentFramesOut: number;
  agentFramesIn: number;
  twilioFramesOut: number;
  bufferedFrames: number;
  droppedFrames: number;
  clears: number;
  /** Distinct sample rates observed on inbound agent audio. */
  agentSampleRates: number[];
  /**
   * Peak absolute PCM16 amplitude seen at each stage (0-32767).
   *
   * Frame counts alone cannot distinguish "audio flowing" from "silence
   * flowing": a muted call moves exactly as many bytes as a loud one. These
   * pinpoint which leg of the bridge lost the signal.
   */
  peakCallerIn: number;
  peakToAgent: number;
  peakAgentIn: number;
  peakToTwilio: number;
}

/**
 * Full-duplex audio bridge between a Twilio Media Stream and the Lyzr agent.
 *
 *   Twilio -> base64 mu-law 8k -> PCM16 8k -> resample -> capture rate -> agent
 *   agent  -> PCM16 @ frame rate -> resample -> 8k -> mu-law -> base64 -> Twilio
 *
 * Resamplers hold filter state across frames, so packet boundaries stay
 * click-free. The OUTBOUND rate is fixed (we choose it); the INBOUND rate is
 * read from each agent frame and never assumed - if it changes mid-call the
 * downstream resampler is rebuilt. Nothing touches disk, no subprocess is spawned.
 */
export class AudioBridge {
  private readonly toAgent: AudioResampler;
  private readonly log: Logger;

  /** Built lazily, keyed by the agent's actual frame rate. */
  private toTwilio: AudioResampler | undefined;
  private toTwilioRate: number | undefined;

  /** Caller audio captured before the agent side finished connecting. */
  private preconnectQueue: Buffer[] = [];
  private readonly preconnectFrameLimit: number;
  private agentReady = false;
  private closed = false;

  /** Outbound mu-law awaiting frame-aligned delivery to Twilio. */
  private outboundRemainder = Buffer.alloc(0);
  private markCounter = 0;

  private stats: BridgeStats = {
    twilioFramesIn: 0,
    agentFramesOut: 0,
    agentFramesIn: 0,
    twilioFramesOut: 0,
    bufferedFrames: 0,
    droppedFrames: 0,
    clears: 0,
    agentSampleRates: [],
    peakCallerIn: 0,
    peakToAgent: 0,
    peakAgentIn: 0,
    peakToTwilio: 0,
  };

  /** Highest absolute sample in a PCM16 LE buffer. */
  private static peak(pcm: Buffer): number {
    let max = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const v = Math.abs(pcm.readInt16LE(i));
      if (v > max) max = v;
    }
    return max;
  }

  constructor(private readonly options: AudioBridgeOptions) {
    this.toAgent = createResampler(TWILIO_SAMPLE_RATE, options.captureSampleRate);
    this.log = options.logger;
    // Twilio delivers 20ms frames, so the cap converts directly to frames.
    this.preconnectFrameLimit = Math.max(1, Math.ceil(options.preconnectBufferMs / 20));
  }

  getStats(): Readonly<BridgeStats> {
    return { ...this.stats, agentSampleRates: [...this.stats.agentSampleRates] };
  }

  /** Flushes buffered caller audio once the agent side is live. */
  markAgentReady(): void {
    if (this.agentReady || this.closed) return;
    this.agentReady = true;

    const queued = this.preconnectQueue;
    this.preconnectQueue = [];
    for (const pcm of queued) this.forwardPcmToAgent(pcm);

    this.log.info(
      { event: "audio_bridge_started", flushedFrames: queued.length, streamSid: this.options.streamSid },
      "agent audio path ready; flushed pre-connect audio",
    );
  }

  /** Handles one base64 mu-law payload from Twilio. */
  handleTwilioAudio(base64Payload: string): void {
    if (this.closed) return;
    this.stats.twilioFramesIn++;

    const mulaw = Buffer.from(base64Payload, "base64");
    if (mulaw.length === 0) return;
    const pcm8k = decodeMuLaw(mulaw);
    this.stats.peakCallerIn = Math.max(this.stats.peakCallerIn, AudioBridge.peak(pcm8k));

    if (!this.agentReady) {
      this.bufferPreconnect(pcm8k);
      return;
    }
    this.forwardPcmToAgent(pcm8k);
  }

  /**
   * Holds early caller audio so the opening of the call is not lost, dropping
   * the OLDEST frame past the cap. Memory stays bounded no matter how long the
   * agent takes to join the room.
   */
  private bufferPreconnect(pcm8k: Buffer): void {
    this.preconnectQueue.push(pcm8k);
    this.stats.bufferedFrames++;

    while (this.preconnectQueue.length > this.preconnectFrameLimit) {
      this.preconnectQueue.shift();
      this.stats.droppedFrames++;
      if (this.stats.droppedFrames === 1) {
        this.log.warn(
          { event: "audio_preconnect_overflow", limitFrames: this.preconnectFrameLimit },
          "pre-connect buffer full; dropping oldest caller audio",
        );
      }
    }
  }

  private forwardPcmToAgent(pcm8k: Buffer): void {
    if (!this.options.transport.isAgentReady()) return;
    const resampled = this.toAgent.process(pcm8k);
    if (resampled.length === 0) return;

    this.stats.peakToAgent = Math.max(this.stats.peakToAgent, AudioBridge.peak(resampled));
    this.options.transport.sendToAgent(resampled);
    this.stats.agentFramesOut++;
  }

  /**
   * Handles one PCM16 buffer from the agent, emitting Twilio media frames.
   * `sampleRate` comes from the frame's own metadata.
   */
  handleAgentAudio(pcm: Buffer, sampleRate: number): void {
    if (this.closed || pcm.length === 0) return;
    this.stats.agentFramesIn++;

    this.stats.peakAgentIn = Math.max(this.stats.peakAgentIn, AudioBridge.peak(pcm));

    if (!this.stats.agentSampleRates.includes(sampleRate)) {
      this.stats.agentSampleRates.push(sampleRate);
    }

    // Rebuild only when the agent's rate actually changes.
    if (!this.toTwilio || this.toTwilioRate !== sampleRate) {
      this.toTwilio = createResampler(sampleRate, TWILIO_SAMPLE_RATE);
      this.toTwilioRate = sampleRate;
      this.log.debug({ event: "agent_sample_rate", sampleRate }, "using agent frame sample rate");
    }

    const pcm8k = this.toTwilio.process(pcm);
    if (pcm8k.length === 0) return;

    this.stats.peakToTwilio = Math.max(this.stats.peakToTwilio, AudioBridge.peak(pcm8k));

    const mulaw = encodeMuLaw(pcm8k);
    const combined =
      this.outboundRemainder.length > 0 ? Buffer.concat([this.outboundRemainder, mulaw]) : mulaw;

    // Emit whole 20ms frames; carry the remainder into the next chunk so we
    // never send a short frame or pad with artificial silence mid-utterance.
    let offset = 0;
    while (combined.length - offset >= TWILIO_FRAME_BYTES) {
      this.sendTwilioFrame(combined.subarray(offset, offset + TWILIO_FRAME_BYTES));
      offset += TWILIO_FRAME_BYTES;
    }
    // Copy the sub-160-byte tail rather than retaining a view onto the whole
    // chunk's backing buffer.
    this.outboundRemainder = Buffer.from(combined.subarray(offset));
  }

  private sendTwilioFrame(frame: Buffer): void {
    this.options.transport.sendToTwilio(
      JSON.stringify({
        event: "media",
        streamSid: this.options.streamSid,
        media: { payload: frame.toString("base64") },
      }),
    );
    this.stats.twilioFramesOut++;
  }

  /**
   * Barge-in: discards audio Twilio has buffered but not yet played.
   *
   * LiveKit stops delivering the agent's old frames when it is interrupted, so
   * this clears what we already handed to Twilio.
   */
  clearTwilioAudio(): void {
    if (this.closed) return;

    this.outboundRemainder = Buffer.alloc(0);
    this.toTwilio?.reset();
    this.stats.clears++;

    this.options.transport.sendToTwilio(
      JSON.stringify({ event: "clear", streamSid: this.options.streamSid }),
    );
  }

  /** Emits a mark so Twilio tells us when the queued audio finished playing. */
  sendMark(name?: string): string {
    const markName = name ?? `m${++this.markCounter}`;
    this.options.transport.sendToTwilio(
      JSON.stringify({ event: "mark", streamSid: this.options.streamSid, mark: { name: markName } }),
    );
    return markName;
  }

  /** Releases buffers and filter state. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    this.preconnectQueue = [];
    this.outboundRemainder = Buffer.alloc(0);
    this.toAgent.reset();
    this.toTwilio?.reset();

    this.log.info({ event: "audio_bridge_stopped", ...this.stats }, "audio bridge stopped");
  }
}
