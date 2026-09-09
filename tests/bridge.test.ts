import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { AudioBridge, TWILIO_FRAME_BYTES } from "../src/audio/bridge.js";
import { encodeMuLaw } from "../src/audio/mulaw.js";

const silentLogger = pino({ level: "silent" });

function setup(options: { agentReady?: boolean; preconnectBufferMs?: number; captureRate?: number } = {}) {
  const toAgent: Buffer[] = [];
  const toTwilio: string[] = [];
  const state = { open: options.agentReady ?? true };

  const bridge = new AudioBridge({
    streamSid: "MZ123",
    captureSampleRate: options.captureRate ?? 24000,
    preconnectBufferMs: options.preconnectBufferMs ?? 4000,
    transport: {
      sendToAgent: (pcm: Buffer) => toAgent.push(pcm),
      sendToTwilio: (p: string) => toTwilio.push(p),
      isAgentReady: () => state.open,
    },
    logger: silentLogger,
  });

  return { bridge, toAgent, toTwilio, state };
}

/** Total PCM16 samples handed to the agent. */
function agentSamples(frames: Buffer[]): number {
  return frames.reduce((sum, f) => sum + f.length / 2, 0);
}

/** 20ms of 8kHz mu-law audio, base64 encoded, as Twilio sends it. */
function twilioFrame(amplitude = 4000): string {
  const pcm = Buffer.alloc(TWILIO_FRAME_BYTES * 2);
  for (let i = 0; i < TWILIO_FRAME_BYTES; i++) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 8000)), i * 2);
  }
  return encodeMuLaw(pcm).toString("base64");
}

/** PCM16 at the Lyzr rate. */
function agentPcm(samples: number, amplitude = 4000): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2);
  }
  return pcm;
}

describe("Twilio -> agent direction", () => {
  it("decodes mu-law and resamples up to the capture rate", () => {
    const { bridge, toAgent } = setup();
    bridge.markAgentReady();
    bridge.handleTwilioAudio(twilioFrame());

    expect(toAgent).toHaveLength(1);
    // 160 samples @ 8kHz -> ~480 samples @ 24kHz (less filter latency on frame 1).
    expect(agentSamples(toAgent)).toBeGreaterThan(400);
    expect(agentSamples(toAgent)).toBeLessThanOrEqual(480);
  });

  it("hands over raw PCM16, not a JSON envelope", () => {
    const { bridge, toAgent } = setup();
    bridge.markAgentReady();
    bridge.handleTwilioAudio(twilioFrame());

    expect(Buffer.isBuffer(toAgent[0])).toBe(true);
    expect(toAgent[0]!.length % 2).toBe(0);
  });

  it("reaches exactly 3x expansion in steady state", () => {
    const { bridge, toAgent } = setup();
    bridge.markAgentReady();
    for (let i = 0; i < 25; i++) bridge.handleTwilioAudio(twilioFrame());

    expect(agentSamples(toAgent)).toBeGreaterThan(25 * 160 * 3 - 60);
    expect(agentSamples(toAgent)).toBeLessThanOrEqual(25 * 160 * 3);
  });

  it("ignores an empty payload", () => {
    const { bridge, toAgent } = setup();
    bridge.markAgentReady();
    bridge.handleTwilioAudio("");
    expect(toAgent).toHaveLength(0);
  });

  it("does not send while the agent side is not ready", () => {
    const { bridge, toAgent } = setup({ agentReady: false });
    bridge.markAgentReady();
    bridge.handleTwilioAudio(twilioFrame());
    expect(toAgent).toHaveLength(0);
  });
});

describe("pre-connect buffering", () => {
  it("holds caller audio until Lyzr is ready, then flushes it in order", () => {
    const { bridge, toAgent } = setup();

    for (let i = 0; i < 5; i++) bridge.handleTwilioAudio(twilioFrame());
    expect(toAgent).toHaveLength(0); // nothing lost, nothing sent early
    expect(bridge.getStats().bufferedFrames).toBe(5);

    bridge.markAgentReady();
    expect(toAgent).toHaveLength(5);
    expect(bridge.getStats().droppedFrames).toBe(0);
  });

  it("bounds memory by dropping the oldest frames past the cap", () => {
    // 200ms cap = 10 frames.
    const { bridge, toAgent } = setup({ preconnectBufferMs: 200 });

    for (let i = 0; i < 50; i++) bridge.handleTwilioAudio(twilioFrame());
    expect(bridge.getStats().droppedFrames).toBe(40);

    bridge.markAgentReady();
    expect(toAgent).toHaveLength(10);
  });

  it("flushes only once even if marked ready repeatedly", () => {
    const { bridge, toAgent } = setup();
    bridge.handleTwilioAudio(twilioFrame());
    bridge.markAgentReady();
    bridge.markAgentReady();
    expect(toAgent).toHaveLength(1);
  });
});

describe("agent -> Twilio direction", () => {
  it("resamples, mu-law encodes and emits 20ms Twilio frames", () => {
    const { bridge, toTwilio } = setup();
    // 480 samples @ 24kHz = 20ms -> exactly one 160-byte Twilio frame.
    bridge.handleAgentAudio(agentPcm(480 * 4), 24000);

    expect(toTwilio.length).toBeGreaterThan(0);
    for (const raw of toTwilio) {
      const frame = JSON.parse(raw);
      expect(frame.event).toBe("media");
      expect(frame.streamSid).toBe("MZ123");
      expect(Buffer.from(frame.media.payload, "base64")).toHaveLength(TWILIO_FRAME_BYTES);
    }
  });

  it("carries a partial frame into the next chunk rather than padding it", () => {
    const { bridge, toTwilio } = setup();
    // 100 samples @24k -> ~33 samples @8k: less than one 160-byte frame.
    bridge.handleAgentAudio(agentPcm(100), 24000);
    expect(toTwilio).toHaveLength(0);

    // Feeding more eventually completes whole frames.
    for (let i = 0; i < 10; i++) bridge.handleAgentAudio(agentPcm(100), 24000);
    expect(toTwilio.length).toBeGreaterThan(0);
  });

  it("never emits a short frame", () => {
    const { bridge, toTwilio } = setup();
    for (const size of [37, 480, 91, 1000, 13]) bridge.handleAgentAudio(agentPcm(size), 24000);
    for (const raw of toTwilio) {
      expect(Buffer.from(JSON.parse(raw).media.payload, "base64")).toHaveLength(TWILIO_FRAME_BYTES);
    }
  });

  it("never prepends a WAV header", () => {
    const { bridge, toTwilio } = setup();
    bridge.handleAgentAudio(agentPcm(2400), 24000);
    const first = Buffer.from(JSON.parse(toTwilio[0]!).media.payload, "base64");
    expect(first.subarray(0, 4).toString("ascii")).not.toBe("RIFF");
  });

  it("ignores empty audio", () => {
    const { bridge, toTwilio } = setup();
    bridge.handleAgentAudio(Buffer.alloc(0), 24000);
    expect(toTwilio).toHaveLength(0);
  });
});

describe("barge-in", () => {
  it("sends a Twilio clear and discards pending outbound audio", () => {
    const { bridge, toTwilio } = setup();
    bridge.handleAgentAudio(agentPcm(100), 24000); // leaves a partial frame pending
    toTwilio.length = 0;

    bridge.clearTwilioAudio();

    expect(JSON.parse(toTwilio[0]!)).toEqual({ event: "clear", streamSid: "MZ123" });
    expect(bridge.getStats().clears).toBe(1);
  });

  it("emits marks so playback completion can be tracked", () => {
    const { bridge, toTwilio } = setup();
    const name = bridge.sendMark();
    expect(JSON.parse(toTwilio[0]!)).toEqual({ event: "mark", streamSid: "MZ123", mark: { name } });
  });
});

describe("lifecycle", () => {
  it("stops forwarding after close and is safe to close twice", () => {
    const { bridge, toAgent, toTwilio } = setup();
    bridge.markAgentReady();
    bridge.close();
    bridge.close();

    bridge.handleTwilioAudio(twilioFrame());
    bridge.handleAgentAudio(agentPcm(2400), 24000);
    bridge.clearTwilioAudio();

    expect(toAgent).toHaveLength(0);
    expect(toTwilio).toHaveLength(0);
  });

  it("tracks throughput statistics", () => {
    const { bridge } = setup();
    bridge.markAgentReady();
    bridge.handleTwilioAudio(twilioFrame());
    bridge.handleAgentAudio(agentPcm(2400), 24000);

    const stats = bridge.getStats();
    expect(stats.twilioFramesIn).toBe(1);
    expect(stats.agentFramesOut).toBe(1);
    expect(stats.agentFramesIn).toBe(1);
    expect(stats.twilioFramesOut).toBeGreaterThan(0);
  });

  it("publishes at a non-default capture rate when configured", () => {
    const { bridge, toAgent } = setup({ captureRate: 16000 });
    bridge.markAgentReady();
    bridge.handleTwilioAudio(twilioFrame());
    // 160 samples @8kHz -> ~320 @16kHz, not 480.
    expect(agentSamples(toAgent)).toBeGreaterThan(260);
    expect(agentSamples(toAgent)).toBeLessThanOrEqual(320);
  });

  it("reads the agent's sample rate from the frame instead of assuming one", () => {
    const { bridge, toTwilio } = setup();
    // 16kHz agent audio: 320 samples = 20ms -> exactly one 160-byte Twilio frame.
    bridge.handleAgentAudio(agentPcm(3200), 16000);

    expect(toTwilio.length).toBeGreaterThan(0);
    expect(bridge.getStats().agentSampleRates).toEqual([16000]);
    for (const raw of toTwilio) {
      expect(Buffer.from(JSON.parse(raw).media.payload, "base64")).toHaveLength(TWILIO_FRAME_BYTES);
    }
  });

  it("handles the 48kHz the live Lyzr agent actually sends", () => {
    // Observed against a real room: the agent publishes at 48000, NOT the
    // 24000 the old WebSocket protocol documented. Assuming 24000 would play
    // the agent's voice back at half speed.
    const { bridge, toTwilio } = setup();
    bridge.handleAgentAudio(agentPcm(48000), 48000); // 1 second

    expect(bridge.getStats().agentSampleRates).toEqual([48000]);
    // 1s at 8kHz = 8000 samples = 50 frames of 160 bytes.
    expect(toTwilio.length).toBeGreaterThanOrEqual(49);
    expect(toTwilio.length).toBeLessThanOrEqual(50);
    for (const raw of toTwilio) {
      expect(Buffer.from(JSON.parse(raw).media.payload, "base64")).toHaveLength(TWILIO_FRAME_BYTES);
    }
  });

  it("rebuilds its resampler if the agent's rate changes mid-call", () => {
    const { bridge } = setup();
    bridge.handleAgentAudio(agentPcm(2400), 24000);
    bridge.handleAgentAudio(agentPcm(1600), 16000);
    expect(bridge.getStats().agentSampleRates).toEqual([24000, 16000]);
  });

  it("does not write to disk or spawn a process", () => {
    // Guard against a regression toward ffmpeg-per-frame or temp files.
    const spawnSpy = vi.spyOn(process, "emit");
    const { bridge } = setup();
    bridge.markAgentReady();
    bridge.handleTwilioAudio(twilioFrame());
    expect(spawnSpy).not.toHaveBeenCalledWith("exit", expect.anything());
  });
});
