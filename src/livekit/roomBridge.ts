import type { Logger } from "pino";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  ParticipantKind,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "@livekit/rtc-node";
import { writeFile } from "node:fs/promises";
import type { LiveKitSession } from "../lyzr/schemas.js";
import { CAPTURE_SAMPLE_RATE } from "../lyzr/schemas.js";
import { buildWav } from "../audio/wav.js";

/** 20 ms at the capture rate - matches Twilio's cadence. */
const CAPTURE_FRAME_MS = 20;

/** Cap on buffered debug audio: ~10s of 48kHz mono PCM16. */
const DEBUG_AUDIO_MAX_BYTES = 48000 * 2 * 10;

/** What the remote agent track actually delivered. */
export interface RemoteAudioStats {
  remote_track_subscribed: boolean;
  remote_audio_frames_received: number;
  remote_pcm_bytes: number;
  remote_sample_rate: number;
  remote_channels: number;
  /** Highest absolute sample seen, to separate real speech from silence. */
  remote_peak: number;
}

export interface RoomBridgeCallbacks {
  /** Called with each MONO PCM16 buffer from the agent, plus its sample rate. */
  onAgentAudio(pcm: Buffer, sampleRate: number): void;
  /** Called once the agent's track is subscribed and audio can flow. */
  onAgentReady(): void;
  onClosed(reason: string): void;
  onError(err: unknown): void;
}

/**
 * Joins the LiveKit room Lyzr dispatched its agent into, publishes the
 * prospect's audio, and streams the agent's audio back.
 *
 * The only credential is the Lyzr-issued `userToken` - no LiveKit API key or
 * secret is involved, because we join as a participant rather than minting
 * tokens ourselves.
 */
export class LiveKitRoomBridge {
  private room: Room | undefined;
  private source: AudioSource | undefined;
  private track: LocalAudioTrack | undefined;
  private trackSid: string | undefined;
  private agentStream: AudioStream | undefined;
  /** True once we are on the agent's speech track rather than its ambience. */
  private usingMicrophoneTrack = false;
  private streamReader: ReadableStreamDefaultReader<AudioFrame> | undefined;
  private closed = false;

  private remoteStats: RemoteAudioStats = {
    remote_track_subscribed: false,
    remote_audio_frames_received: 0,
    remote_pcm_bytes: 0,
    remote_sample_rate: 0,
    remote_channels: 0,
    remote_peak: 0,
  };

  /** Captured before mu-law conversion, for offline inspection in dev only. */
  private debugPcm: Buffer[] = [];
  private debugBytes = 0;

  /** Leftover capture samples awaiting a whole frame. */
  private pending = Buffer.alloc(0);
  private readonly frameSamples: number;

  /**
   * Frames waiting to be handed to LiveKit, plus the single pump draining them.
   *
   * captureFrame() applies BACKPRESSURE: it resolves only once the source has
   * room, so it must be awaited one frame at a time. Firing a burst
   * concurrently - which is exactly what flushing the pre-connect buffer does -
   * overruns the queue and fails with "InvalidState - failed to capture frame".
   */
  private frameQueue: AudioFrame[] = [];
  private pumping = false;

  constructor(
    private readonly session: LiveKitSession,
    private readonly callbacks: RoomBridgeCallbacks,
    private readonly logger: Logger,
    private readonly captureSampleRate = CAPTURE_SAMPLE_RATE,
    /**
     * Development only. Retaining call audio in production would be both a
     * privacy problem and an unbounded memory cost.
     */
    private readonly debugAudioEnabled = false,
  ) {
    this.frameSamples = Math.round((this.captureSampleRate * CAPTURE_FRAME_MS) / 1000);
  }

  get isReady(): boolean {
    return !this.closed && this.source !== undefined;
  }

  getRemoteStats(): Readonly<RemoteAudioStats> {
    return { ...this.remoteStats };
  }

  /**
   * Interleaved multi-channel PCM16 -> mono, by averaging channels.
   *
   * Treating interleaved stereo as mono would read alternate samples from
   * alternate channels and destroy the waveform, so the layout the frame
   * actually reports is honoured rather than assumed.
   */
  static downmixToMono(pcm: Buffer, channels: number): Buffer {
    if (channels <= 1) return pcm;

    const frames = Math.floor(pcm.length / 2 / channels);
    const out = Buffer.allocUnsafe(frames * 2);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((f * channels + c) * 2);
      out.writeInt16LE(Math.round(sum / channels), f * 2);
    }
    return out;
  }

  async connect(): Promise<void> {
    const room = new Room();
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      this.onTrackSubscribed(track, publication, participant);
    });
    room.on(RoomEvent.TrackUnsubscribed, (_t, _p, participant) => {
      this.logger.info({ event: "livekit_track_unsubscribed", identity: participant.identity }, "agent track ended");
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      if (isAgent(participant)) this.close("agent_left");
    });
    room.on(RoomEvent.Disconnected, () => this.close("room_disconnected"));

    // The Lyzr token is the participant credential.
    await room.connect(this.session.livekitUrl, this.session.userToken, {
      autoSubscribe: true,
      dynacast: false,
    });

    this.logger.info(
      { event: "livekit_room_connected", roomName: this.session.roomName, lyzrSessionId: this.session.sessionId },
      "joined LiveKit room",
    );

    // Publish the prospect's audio as a microphone track.
    // A 1s internal queue absorbs jitter between Twilio's cadence and LiveKit's.
    const source = new AudioSource(this.captureSampleRate, 1, 1000);
    this.source = source;

    const track = LocalAudioTrack.createAudioTrack("prospect", source);
    this.track = track;

    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;

    const publication = await room.localParticipant!.publishTrack(track, options);
    this.trackSid = publication.sid;

    this.logger.info({ event: "livekit_track_published", trackSid: this.trackSid }, "published prospect audio");

    // The agent may already be in the room when we join.
    for (const participant of room.remoteParticipants.values()) {
      if (!isAgent(participant)) continue;
      for (const pub of participant.trackPublications.values()) {
        if (pub.track) this.onTrackSubscribed(pub.track, pub, participant);
      }
    }
  }

  /**
   * Bridges ONLY the remote agent's SPEECH.
   *
   * The agent publishes more than one audio track: its background-audio bed
   * (ambience, source UNKNOWN) and its actual voice (source MICROPHONE). The
   * ambience is usually published first, so taking whichever track arrives
   * first sends the prospect room tone and never a word of speech.
   *
   * The microphone track therefore always wins, and we switch to it if it shows
   * up after we have already started on something else. Our own published track
   * is never routed back - that would echo the prospect to themselves.
   */
  private onTrackSubscribed(
    track: RemoteTrack | undefined,
    publication: RemoteTrackPublication | undefined,
    participant: RemoteParticipant,
  ): void {
    if (this.closed || !track || track.kind !== TrackKind.KIND_AUDIO) return;
    if (!isAgent(participant)) {
      this.logger.debug(
        { event: "livekit_track_ignored", identity: participant.identity },
        "ignoring non-agent participant audio",
      );
      return;
    }

    const isMicrophone = publication?.source === TrackSource.SOURCE_MICROPHONE;

    if (this.agentStream) {
      // Only ever upgrade: a microphone track replaces a non-microphone one.
      if (!isMicrophone || this.usingMicrophoneTrack) {
        this.logger.debug(
          { event: "livekit_track_ignored", trackSid: track.sid, source: publication?.source },
          "already bridging the agent's speech track",
        );
        return;
      }
      this.logger.info(
        { event: "livekit_agent_track_switched", trackSid: track.sid },
        "switching to the agent's microphone track",
      );
      void this.streamReader?.cancel().catch(() => undefined);
      this.streamReader = undefined;
      this.agentStream = undefined;
    }

    this.usingMicrophoneTrack = isMicrophone;

    this.logger.info(
      {
        event: "livekit_agent_track_subscribed",
        identity: participant.identity,
        trackSid: track.sid,
        source: publication?.source,
        isMicrophone,
      },
      "subscribed to agent audio",
    );

    // No sample rate is requested, so frames arrive at the agent's native rate
    // and each one reports it.
    const stream = new AudioStream(track);
    this.agentStream = stream;
    this.remoteStats.remote_track_subscribed = true;

    this.logger.info(
      { event: "remote_track_subscribed", identity: participant.identity, sid: track.sid },
      "remote agent audio track subscribed",
    );
    this.callbacks.onAgentReady();

    void this.pumpAgentAudio(stream);
  }

  private async pumpAgentAudio(stream: AudioStream): Promise<void> {
    const reader = stream.getReader();
    this.streamReader = reader;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.closed) break;
        if (!value) continue;

        // AudioFrame.data is Int16Array; copy its bytes as PCM16 LE.
        const raw = Buffer.from(
          Buffer.from(value.data.buffer, value.data.byteOffset, value.data.byteLength),
        );

        const channels = value.channels ?? 1;
        const mono = LiveKitRoomBridge.downmixToMono(raw, channels);

        this.remoteStats.remote_audio_frames_received++;
        this.remoteStats.remote_pcm_bytes += raw.length;
        this.remoteStats.remote_sample_rate = value.sampleRate;
        this.remoteStats.remote_channels = channels;
        for (let i = 0; i + 1 < mono.length; i += 2) {
          const v = Math.abs(mono.readInt16LE(i));
          if (v > this.remoteStats.remote_peak) this.remoteStats.remote_peak = v;
        }

        this.captureDebugPcm(mono);
        this.callbacks.onAgentAudio(mono, value.sampleRate);
      }
    } catch (err) {
      if (!this.closed) this.callbacks.onError(err);
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Captures prospect audio into the published track.
   *
   * LiveKit expects whole frames, so partial buffers are held until a full
   * 20 ms frame is available.
   */
  capture(pcm16le: Buffer): void {
    if (this.closed || !this.source) return;

    const combined =
      this.pending.length > 0 ? Buffer.concat([this.pending, pcm16le]) : pcm16le;
    const frameBytes = this.frameSamples * 2;

    let offset = 0;
    while (combined.length - offset >= frameBytes) {
      const slice = combined.subarray(offset, offset + frameBytes);
      // Copy into a fresh Int16Array: the frame outlives this buffer.
      const samples = new Int16Array(this.frameSamples);
      for (let i = 0; i < this.frameSamples; i++) samples[i] = slice.readInt16LE(i * 2);

      this.enqueue(new AudioFrame(samples, this.captureSampleRate, 1, this.frameSamples));
      offset += frameBytes;
    }

    this.pending = Buffer.from(combined.subarray(offset));
  }

  /**
   * Queues a frame and starts the pump.
   *
   * The backlog is bounded at ~2s: if we ever get further behind than that the
   * audio is stale anyway, so the OLDEST frames are dropped rather than growing
   * unboundedly or stalling the bridge.
   */
  private enqueue(frame: AudioFrame): void {
    const maxFrames = Math.ceil(2000 / CAPTURE_FRAME_MS);

    this.frameQueue.push(frame);
    while (this.frameQueue.length > maxFrames) this.frameQueue.shift();

    if (!this.pumping) void this.pump();
  }

  /** Drains the queue one frame at a time, respecting captureFrame's pacing. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;

    try {
      while (!this.closed && this.frameQueue.length > 0) {
        const frame = this.frameQueue.shift();
        if (!frame || !this.source) break;
        await this.source.captureFrame(frame);
      }
    } catch (err) {
      // A capture failure after teardown is expected; anything else is real.
      if (!this.closed) this.callbacks.onError(err);
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Buffers a few seconds of the agent's audio, pre-mu-law, so it can be
   * written out and listened to. Development only - never enabled in
   * production, where it would retain call audio in memory and on disk.
   */
  private captureDebugPcm(mono: Buffer): void {
    if (!this.debugAudioEnabled || this.debugBytes >= DEBUG_AUDIO_MAX_BYTES) return;
    this.debugPcm.push(mono);
    this.debugBytes += mono.length;
  }

  /** Writes the captured agent audio as a WAV. Returns the path, or null. */
  async writeDebugWav(dir: string, callId: string): Promise<string | null> {
    if (!this.debugAudioEnabled || this.debugPcm.length === 0) return null;

    const pcm = Buffer.concat(this.debugPcm);
    const rate = this.remoteStats.remote_sample_rate || 48000;
    const path = `${dir.replace(/\/+$/, "")}/agent-${callId}.wav`;

    await writeFile(path, buildWav(pcm, rate, 1));
    this.logger.info(
      { event: "debug_audio_written", path, bytes: pcm.length, sampleRate: rate },
      "wrote agent audio for offline inspection",
    );
    return path;
  }

  /** Tears down the room, track and source exactly once. */
  async close(reason = "closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending = Buffer.alloc(0);
    this.frameQueue = [];
    this.debugPcm = [];

    try {
      await this.streamReader?.cancel().catch(() => undefined);
    } catch {
      // reader may already be released
    }
    this.streamReader = undefined;
    this.agentStream = undefined;

    if (this.room && this.trackSid) {
      await this.room.localParticipant?.unpublishTrack(this.trackSid, true).catch(() => undefined);
    }
    this.trackSid = undefined;
    this.track = undefined;

    await this.source?.close().catch(() => undefined);
    this.source = undefined;

    await this.room?.disconnect().catch(() => undefined);
    this.room = undefined;

    this.logger.info({ event: "livekit_room_closed", reason }, "left LiveKit room");
    this.callbacks.onClosed(reason);
  }
}

/**
 * Identifies the Lyzr agent participant.
 *
 * LiveKit marks dispatched agents with `ParticipantKind.AGENT`; the identity
 * check is a fallback for deployments that join as a standard participant.
 */
export function isAgent(participant: { kind?: number; identity?: string }): boolean {
  if (participant.kind === ParticipantKind.AGENT) return true;
  const identity = participant.identity ?? "";
  // Never treat our own twilio-<callId> participant as the agent.
  if (identity.startsWith("twilio-")) return false;
  return /agent|lyzr/i.test(identity);
}
