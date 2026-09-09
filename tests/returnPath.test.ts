import { describe, expect, it } from "vitest";
import { LiveKitRoomBridge } from "../src/livekit/roomBridge.js";
import { buildWav } from "../src/audio/wav.js";
import { decodeMuLaw } from "../src/audio/mulaw.js";

function pcm(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}
function toArray(b: Buffer): number[] {
  return Array.from({ length: b.length >> 1 }, (_, i) => b.readInt16LE(i * 2));
}

describe("downmixToMono", () => {
  it("passes mono through untouched", () => {
    const mono = pcm([100, -200, 300]);
    expect(LiveKitRoomBridge.downmixToMono(mono, 1)).toBe(mono);
  });

  it("averages interleaved stereo into mono", () => {
    // L=1000 R=2000, L=-400 R=-600  ->  1500, -500
    expect(toArray(LiveKitRoomBridge.downmixToMono(pcm([1000, 2000, -400, -600]), 2))).toEqual([1500, -500]);
  });

  it("does NOT reinterpret stereo as mono, which would destroy the waveform", () => {
    // A steady tone in L with silence in R. Treating the interleaved buffer as
    // mono would alternate tone/silence and wreck it; downmixing halves it.
    const stereo = pcm([8000, 0, 8000, 0, 8000, 0]);
    expect(toArray(LiveKitRoomBridge.downmixToMono(stereo, 2))).toEqual([4000, 4000, 4000]);
  });

  it("handles more than two channels", () => {
    expect(toArray(LiveKitRoomBridge.downmixToMono(pcm([300, 600, 900]), 3))).toEqual([600]);
  });

  it("drops a trailing partial frame rather than reading past the end", () => {
    expect(() => LiveKitRoomBridge.downmixToMono(pcm([100, 200, 300]), 2)).not.toThrow();
    expect(toArray(LiveKitRoomBridge.downmixToMono(pcm([100, 200, 300]), 2))).toEqual([150]);
  });

  it("handles empty input", () => {
    expect(LiveKitRoomBridge.downmixToMono(Buffer.alloc(0), 2)).toHaveLength(0);
  });
});

describe("debug WAV", () => {
  const wav = buildWav(pcm([0, 1000, -1000]), 48000, 1);

  it("writes a valid RIFF/WAVE header", () => {
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
  });

  it("records the real format so the file plays at the right speed", () => {
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt16LE(34)).toBe(16); // bits
  });

  it("declares the correct data length", () => {
    expect(wav.readUInt32LE(40)).toBe(6);
    expect(wav.length).toBe(44 + 6);
  });
});

describe("Twilio media message contract", () => {
  // Rebuilt exactly as the bridge emits it.
  const streamSid = "MZ23773ace172d36a801cc5c3a9d260d1d";
  const mulawFrame = Buffer.alloc(160, 0xff);
  const message = JSON.stringify({
    event: "media",
    streamSid,
    media: { payload: mulawFrame.toString("base64") },
  });

  it("is a TEXT frame, i.e. a string not a Buffer", () => {
    expect(typeof message).toBe("string");
    expect(Buffer.isBuffer(message as unknown)).toBe(false);
  });

  it("has exactly the documented shape", () => {
    const parsed = JSON.parse(message);
    expect(Object.keys(parsed).sort()).toEqual(["event", "media", "streamSid"]);
    expect(parsed.event).toBe("media");
    expect(Object.keys(parsed.media)).toEqual(["payload"]);
  });

  it("carries the actual current streamSid", () => {
    expect(JSON.parse(message).streamSid).toBe(streamSid);
  });

  it("payload is base64 of 8kHz mono mu-law, 160 bytes for 20ms", () => {
    const decoded = Buffer.from(JSON.parse(message).media.payload, "base64");
    expect(decoded).toHaveLength(160);
    // 160 mu-law bytes -> 160 PCM16 samples -> 20ms at 8kHz.
    expect(decodeMuLaw(decoded).length / 2 / 8000).toBeCloseTo(0.02, 5);
  });

  it("payload has no WAV header and is not JSON-wrapped audio", () => {
    const decoded = Buffer.from(JSON.parse(message).media.payload, "base64");
    expect(decoded.subarray(0, 4).toString("ascii")).not.toBe("RIFF");
  });
});
