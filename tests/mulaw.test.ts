import { describe, expect, it } from "vitest";
import { decodeMuLaw, encodeMuLaw, muLawSilence } from "../src/audio/mulaw.js";

describe("G.711 mu-law codec", () => {
  it("decodes the ITU reference extremes", () => {
    // mu-law has two zero codes: 0xFF (positive) and 0x7F (negative).
    const decoded = decodeMuLaw(Buffer.from([0xff, 0x7f]));
    expect(decoded.readInt16LE(0)).toBe(0);
    expect(decoded.readInt16LE(2)).toBe(0);

    // mu-law bytes are stored complemented, so 0x00 is full-scale NEGATIVE
    // and 0x80 is full-scale positive. Magnitude is the ITU clip point, 32124.
    const extremes = decodeMuLaw(Buffer.from([0x00, 0x80]));
    expect(extremes.readInt16LE(0)).toBe(-32124);
    expect(extremes.readInt16LE(2)).toBe(32124);
  });

  it("encodes silence to 0xFF", () => {
    const pcm = Buffer.alloc(8); // four zero samples
    expect([...encodeMuLaw(pcm)]).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it("produces one mu-law byte per PCM16 sample", () => {
    const pcm = Buffer.alloc(320); // 160 samples = 20ms @ 8kHz
    expect(encodeMuLaw(pcm)).toHaveLength(160);
    expect(decodeMuLaw(encodeMuLaw(pcm))).toHaveLength(320);
  });

  it("ignores a trailing odd byte rather than reading out of bounds", () => {
    expect(encodeMuLaw(Buffer.from([0x00, 0x01, 0x02]))).toHaveLength(1);
  });

  it("round-trips within mu-law quantisation error", () => {
    const samples = [0, 1, -1, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000];
    const pcm = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => pcm.writeInt16LE(s, i * 2));

    const round = decodeMuLaw(encodeMuLaw(pcm));
    samples.forEach((original, i) => {
      const result = round.readInt16LE(i * 2);
      // mu-law is logarithmic: ~8% relative error at high amplitude.
      const tolerance = Math.max(8, Math.abs(original) * 0.08);
      expect(Math.abs(result - original)).toBeLessThanOrEqual(tolerance);
    });
  });

  it("clamps rather than wraps beyond the mu-law clip point", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(32767, 0);
    pcm.writeInt16LE(-32768, 2);
    const round = decodeMuLaw(encodeMuLaw(pcm));
    expect(round.readInt16LE(0)).toBe(32124);
    expect(round.readInt16LE(2)).toBe(-32124);
  });

  it("is stable across a full encode/decode/encode cycle, except negative zero", () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const cycled = encodeMuLaw(decodeMuLaw(all));

    // Every code is idempotent apart from 0x7F, the negative-zero encoding,
    // which necessarily collapses onto the canonical zero code 0xFF.
    const changed = [...all].filter((code, i) => cycled[i] !== code);
    expect(changed).toEqual([0x7f]);
    expect(cycled[0x7f]).toBe(0xff);
  });

  it("builds silence frames", () => {
    expect([...muLawSilence(3)]).toEqual([0xff, 0xff, 0xff]);
    expect(decodeMuLaw(muLawSilence(160)).every((b) => b === 0)).toBe(true);
  });

  it("handles empty input", () => {
    expect(encodeMuLaw(Buffer.alloc(0))).toHaveLength(0);
    expect(decodeMuLaw(Buffer.alloc(0))).toHaveLength(0);
  });
});
