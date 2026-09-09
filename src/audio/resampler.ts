/**
 * Streaming rational resampler for the Twilio <-> Lyzr bridge.
 *
 * The hot path is 8 kHz <-> 24 kHz, an exact 3:1 ratio. Rather than duplicating
 * or dropping samples (which aliases badly on speech), this runs a polyphase
 * windowed-sinc FIR: the prototype lowpass is designed once per instance, split
 * into `L` phases, and applied without ever materialising the zero-stuffed
 * intermediate signal.
 *
 * State (the filter's input history and the fractional output phase) persists
 * across `process()` calls, so 20 ms packets stitch together with no clicks at
 * the boundaries. One instance is created per stream direction per call - never
 * per frame.
 */

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** Zeroth-order modified Bessel function, for the Kaiser window. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const halfX = x / 2;
  for (let k = 1; k < 50; k++) {
    term *= (halfX / k) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

/**
 * Windowed-sinc lowpass, Kaiser window (beta 8 ~= 80 dB stopband).
 * `cutoff` is in cycles/sample of the *interpolated* rate.
 */
function designLowpass(numTaps: number, cutoff: number, gain: number): Float64Array {
  const taps = new Float64Array(numTaps);
  const center = (numTaps - 1) / 2;
  const beta = 8.0;
  const denom = besselI0(beta);

  let sum = 0;
  for (let i = 0; i < numTaps; i++) {
    const t = i - center;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    const ratio = (2 * i) / (numTaps - 1) - 1;
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / denom;
    taps[i] = sinc * window;
    sum += taps[i]!;
  }

  // Normalise to unity DC gain, then apply the interpolation gain (= L).
  const scale = gain / sum;
  for (let i = 0; i < numTaps; i++) taps[i]! *= scale;
  return taps;
}

export interface AudioResampler {
  readonly inputRate: number;
  readonly outputRate: number;
  /** Consumes PCM16 LE, returns PCM16 LE at the output rate. */
  process(pcm16le: Buffer): Buffer;
  /** Flushes the filter tail, then clears state. */
  flush(): Buffer;
  reset(): void;
}

/** Pass-through used when input and output rates already match. */
class IdentityResampler implements AudioResampler {
  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
  ) {}

  process(pcm16le: Buffer): Buffer {
    // Copy so callers may retain/mutate the result independently.
    return Buffer.from(pcm16le);
  }

  flush(): Buffer {
    return Buffer.alloc(0);
  }

  reset(): void {}
}

export class PolyphaseResampler implements AudioResampler {
  private readonly up: number;
  private readonly down: number;
  private readonly phases: Float64Array[];
  private readonly tapsPerPhase: number;

  /** Input history; index 0 holds absolute input sample `inBase`. */
  private history: Float64Array;
  private historyLength = 0;
  private inBase = 0;
  private outIndex = 0;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
    tapsPerPhase = 16,
  ) {
    if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error("inputRate must be positive");
    if (!Number.isFinite(outputRate) || outputRate <= 0) throw new Error("outputRate must be positive");

    const divisor = gcd(inputRate, outputRate);
    this.up = outputRate / divisor;
    this.down = inputRate / divisor;
    this.tapsPerPhase = tapsPerPhase;

    const numTaps = tapsPerPhase * this.up;
    // Nyquist of whichever side is slower, expressed at the interpolated rate.
    const cutoff = 0.5 / Math.max(this.up, this.down);
    const prototype = designLowpass(numTaps, cutoff * 0.92, this.up);

    // Split into `up` phases: phase p holds taps p, p+up, p+2*up, ...
    this.phases = Array.from({ length: this.up }, (_, p) => {
      const phase = new Float64Array(tapsPerPhase);
      for (let k = 0; k < tapsPerPhase; k++) {
        const tapIndex = p + k * this.up;
        phase[k] = tapIndex < numTaps ? prototype[tapIndex]! : 0;
      }
      return phase;
    });

    // Room for the filter history plus a generous working chunk.
    this.history = new Float64Array(tapsPerPhase + 4096);
    this.reset();
  }

  reset(): void {
    this.history.fill(0);
    // Prime the filter with `lag` zero samples sitting at negative absolute
    // indices. Without this the very first output's tap window underflows and
    // the stream would stall instead of producing its start-up transient.
    const lag = this.tapsPerPhase - 1;
    this.historyLength = lag;
    this.inBase = -lag;
    this.outIndex = 0;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.history.length) return;
    const grown = new Float64Array(Math.max(needed, this.history.length * 2));
    grown.set(this.history.subarray(0, this.historyLength));
    this.history = grown;
  }

  /** Runs the polyphase loop over whatever is currently buffered. */
  private render(): Buffer {
    const lag = this.tapsPerPhase - 1;
    const lastAbsolute = this.inBase + this.historyLength - 1;

    // Count the outputs whose full tap window is available.
    let n = this.outIndex;
    let count = 0;
    for (;;) {
      const t = n * this.down;
      const inputIndex = Math.floor(t / this.up);
      if (inputIndex > lastAbsolute || inputIndex - lag < this.inBase) break;
      count++;
      n++;
    }

    const out = Buffer.allocUnsafe(count * 2);
    let written = 0;
    for (let i = 0; i < count; i++) {
      const t = (this.outIndex + i) * this.down;
      const inputIndex = Math.floor(t / this.up);
      // Phase advances backwards through the prototype as `t` advances.
      const phase = this.phases[(this.up - (t % this.up)) % this.up]!;
      const start = inputIndex - this.inBase;

      let acc = 0;
      for (let k = 0; k < this.tapsPerPhase; k++) {
        acc += phase[k]! * this.history[start - k]!;
      }

      // Round then clamp to int16 - speech peaks must not wrap.
      let sample = Math.round(acc);
      if (sample > 32767) sample = 32767;
      else if (sample < -32768) sample = -32768;
      out.writeInt16LE(sample, written);
      written += 2;
    }
    this.outIndex += count;

    // Retain only the samples a future output could still need.
    const nextInput = Math.floor((this.outIndex * this.down) / this.up);
    const keepFrom = Math.max(this.inBase, nextInput - lag);
    const drop = keepFrom - this.inBase;
    if (drop > 0) {
      this.history.copyWithin(0, drop, this.historyLength);
      this.historyLength -= drop;
      this.inBase = keepFrom;
    }

    return out;
  }

  process(pcm16le: Buffer): Buffer {
    const sampleCount = pcm16le.length >> 1;
    if (sampleCount === 0) return Buffer.alloc(0);

    this.ensureCapacity(this.historyLength + sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      this.history[this.historyLength + i] = pcm16le.readInt16LE(i * 2);
    }
    this.historyLength += sampleCount;

    return this.render();
  }

  /** Pads with zeros so the last real samples clear the filter, then resets. */
  flush(): Buffer {
    const tail = Buffer.alloc(this.tapsPerPhase * 2);
    const out = this.process(tail);
    this.reset();
    return out;
  }
}

export function createResampler(inputRate: number, outputRate: number): AudioResampler {
  if (inputRate === outputRate) return new IdentityResampler(inputRate, outputRate);
  return new PolyphaseResampler(inputRate, outputRate);
}
