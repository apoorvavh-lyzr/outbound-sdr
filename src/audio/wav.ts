/**
 * Minimal RIFF/WAVE writer, used ONLY to dump agent audio for offline
 * inspection during development. Never used on the call path - Twilio media is
 * raw mu-law with no container.
 */
export function buildWav(pcm16le: Buffer, sampleRate: number, channels = 1): Buffer {
  const byteRate = sampleRate * channels * 2;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm16le.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm16le.length, 40);

  return Buffer.concat([header, pcm16le]);
}
