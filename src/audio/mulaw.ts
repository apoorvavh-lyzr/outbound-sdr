/**
 * ITU-T G.711 µ-law codec.
 *
 * Twilio Media Streams carry 8 kHz mono µ-law; Lyzr speaks PCM16. Both
 * directions are table-driven so a 20 ms frame costs a lookup per sample.
 */

const BIAS = 0x84;
const CLIP = 32635;

function encodeSample(sample: number): number {
  // Clamp into int16 range before the sign/magnitude split.
  let s = sample;
  if (s > 32767) s = 32767;
  else if (s < -32768) s = -32768;

  const sign = s < 0 ? 0x80 : 0x00;
  let magnitude = s < 0 ? -s : s;
  if (magnitude > CLIP) magnitude = CLIP;
  magnitude += BIAS;

  // Locate the segment (exponent) via the highest set bit.
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (magnitude & mask) === 0; mask >>= 1) {
    exponent--;
  }

  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function decodeSample(byte: number): number {
  const inverted = ~byte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;

  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;

  return sign !== 0 ? -sample : sample;
}

/** Precomputed tables: 256 decode entries, 16384 encode entries (14-bit index). */
const DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) DECODE_TABLE[i] = decodeSample(i);

const ENCODE_TABLE = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) {
  // Index by the unsigned 16-bit view of the signed sample.
  const signed = i >= 32768 ? i - 65536 : i;
  ENCODE_TABLE[i] = encodeSample(signed);
}

/** µ-law bytes -> signed 16-bit LE PCM. */
export function decodeMuLaw(input: Buffer): Buffer {
  const out = Buffer.allocUnsafe(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    out.writeInt16LE(DECODE_TABLE[input[i]!]!, i * 2);
  }
  return out;
}

/** Signed 16-bit LE PCM -> µ-law bytes. Trailing odd byte is ignored. */
export function encodeMuLaw(pcm: Buffer): Buffer {
  const sampleCount = pcm.length >> 1;
  const out = Buffer.allocUnsafe(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = ENCODE_TABLE[pcm.readUInt16LE(i * 2)]!;
  }
  return out;
}

export const MULAW_SILENCE_BYTE = 0xff;

/** A µ-law silence frame of `samples` bytes (1 byte per sample at 8 kHz). */
export function muLawSilence(samples: number): Buffer {
  return Buffer.alloc(samples, MULAW_SILENCE_BYTE);
}

export { encodeSample as encodeMuLawSample, decodeSample as decodeMuLawSample };
