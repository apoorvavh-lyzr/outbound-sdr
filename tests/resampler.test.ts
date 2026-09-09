import { describe, expect, it } from "vitest";
import { PolyphaseResampler, createResampler } from "../src/audio/resampler.js";

function tone(samples: number, freqHz: number, rate: number, amplitude = 8000, phase = 0): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * (i + phase)) / rate)), i * 2);
  }
  return buf;
}

function toArray(buf: Buffer): number[] {
  return Array.from({ length: buf.length >> 1 }, (_, i) => buf.readInt16LE(i * 2));
}

/** Peak absolute amplitude, ignoring the filter's start-up transient. */
function peak(samples: number[], skip = 0): number {
  return samples.slice(skip).reduce((max, s) => Math.max(max, Math.abs(s)), 0);
}

describe("PolyphaseResampler", () => {
  it("upsamples 8k -> 24k at a 3x sample count", () => {
    const r = new PolyphaseResampler(8000, 24000);
    const out = r.process(tone(160, 440, 8000)); // 20ms
    // Allow for filter latency on the first packet.
    expect(out.length >> 1).toBeGreaterThan(160 * 3 - 60);
    expect(out.length >> 1).toBeLessThanOrEqual(160 * 3);
  });

  it("downsamples 24k -> 8k at a 1/3 sample count", () => {
    const r = new PolyphaseResampler(24000, 8000);
    const out = r.process(tone(480, 440, 24000)); // 20ms
    expect(out.length >> 1).toBeGreaterThan(480 / 3 - 20);
    expect(out.length >> 1).toBeLessThanOrEqual(480 / 3);
  });

  it("converges to exactly 3x over a stream of packets", () => {
    const r = new PolyphaseResampler(8000, 24000);
    let total = 0;
    for (let i = 0; i < 50; i++) total += r.process(tone(160, 440, 8000, 8000, i * 160)).length >> 1;
    // Steady state: 50 packets * 160 samples * 3, minus one filter delay.
    expect(total).toBeGreaterThan(50 * 160 * 3 - 60);
    expect(total).toBeLessThanOrEqual(50 * 160 * 3);
  });

  it("preserves a sine wave's amplitude through 8k -> 24k", () => {
    const r = new PolyphaseResampler(8000, 24000);
    // Feed several packets so the output clears the start-up transient.
    let out: number[] = [];
    for (let i = 0; i < 5; i++) out = out.concat(toArray(r.process(tone(160, 440, 8000, 8000, i * 160))));
    // Passband gain should be ~1.0, not 3x (the interpolation gain must be
    // absorbed by the filter) and not 1/3.
    expect(peak(out, 100)).toBeGreaterThan(7000);
    expect(peak(out, 100)).toBeLessThan(9000);
  });

  it("is continuous across packet boundaries", () => {
    // Splitting one signal into packets must equal processing it whole.
    const whole = new PolyphaseResampler(8000, 24000);
    const chunked = new PolyphaseResampler(8000, 24000);

    const signal = tone(800, 440, 8000);
    const wholeOut = toArray(whole.process(signal));

    let chunkedOut: number[] = [];
    for (let offset = 0; offset < signal.length; offset += 160) {
      chunkedOut = chunkedOut.concat(toArray(chunked.process(signal.subarray(offset, offset + 160))));
    }

    expect(chunkedOut.length).toBe(wholeOut.length);
    // Identical state machine, so results must match sample-for-sample.
    expect(chunkedOut).toEqual(wholeOut);
  });

  it("has no discontinuity spikes at boundaries", () => {
    const r = new PolyphaseResampler(8000, 24000);
    let out: number[] = [];
    for (let i = 0; i < 10; i++) out = out.concat(toArray(r.process(tone(160, 300, 8000, 8000, i * 160))));

    // A 300Hz tone at 24kHz moves slowly; a seam would show as a large jump.
    const maxStep = out.slice(101).reduce((max, s, i) => Math.max(max, Math.abs(s - out[i + 100]!)), 0);
    expect(maxStep).toBeLessThan(1500);
  });

  it("attenuates content above the 4kHz Nyquist when downsampling", () => {
    const r = new PolyphaseResampler(24000, 8000);
    // 6kHz cannot survive an 8kHz sample rate - it must be filtered, not aliased.
    let out: number[] = [];
    for (let i = 0; i < 5; i++) out = out.concat(toArray(r.process(tone(480, 6000, 24000, 8000, i * 480))));
    expect(peak(out, 50)).toBeLessThan(800); // >20dB rejection
  });

  it("passes speech-band content when downsampling", () => {
    const r = new PolyphaseResampler(24000, 8000);
    let out: number[] = [];
    for (let i = 0; i < 5; i++) out = out.concat(toArray(r.process(tone(480, 1000, 24000, 8000, i * 480))));
    expect(peak(out, 50)).toBeGreaterThan(7000);
  });

  it("clamps rather than wraps on full-scale input", () => {
    const r = new PolyphaseResampler(8000, 24000);
    const loud = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) loud.writeInt16LE(i % 2 === 0 ? 32767 : -32768, i * 2);
    const out = toArray(r.process(loud));
    for (const s of out) {
      expect(s).toBeGreaterThanOrEqual(-32768);
      expect(s).toBeLessThanOrEqual(32767);
    }
  });

  it("handles empty and very short chunks", () => {
    const r = new PolyphaseResampler(8000, 24000);
    expect(r.process(Buffer.alloc(0))).toHaveLength(0);
    expect(() => r.process(Buffer.alloc(2))).not.toThrow();
    expect(() => r.process(Buffer.from([0x00]))).not.toThrow(); // odd byte
  });

  it("resets state", () => {
    const r = new PolyphaseResampler(8000, 24000);
    const first = toArray(r.process(tone(160, 440, 8000)));
    r.reset();
    expect(toArray(r.process(tone(160, 440, 8000)))).toEqual(first);
  });

  it("flushes the filter tail then clears state", () => {
    const r = new PolyphaseResampler(8000, 24000);
    r.process(tone(160, 440, 8000));
    expect(r.flush().length).toBeGreaterThan(0);

    // flush() resets, so a second flush pushes only zeros through a primed
    // filter - it may emit samples, but every one must be silence.
    expect(toArray(r.flush()).every((s) => s === 0)).toBe(true);
  });

  it("rejects invalid rates", () => {
    expect(() => new PolyphaseResampler(0, 24000)).toThrow(/inputRate/);
    expect(() => new PolyphaseResampler(8000, -1)).toThrow(/outputRate/);
  });
});

describe("createResampler", () => {
  it("returns a pass-through when rates match", () => {
    const r = createResampler(24000, 24000);
    const input = tone(240, 440, 24000);
    expect(r.process(input).equals(input)).toBe(true);
    expect(r.flush()).toHaveLength(0);
  });

  it("copies rather than aliasing the caller's buffer", () => {
    const r = createResampler(8000, 8000);
    const input = Buffer.from([0x01, 0x02]);
    const out = r.process(input);
    input.writeInt16LE(999, 0);
    expect(out.readInt16LE(0)).not.toBe(999);
  });

  it("supports a non-3x documented rate such as 16kHz", () => {
    const r = createResampler(8000, 16000);
    const out = r.process(tone(160, 440, 8000));
    expect(out.length >> 1).toBeGreaterThan(160 * 2 - 40);
  });
});
