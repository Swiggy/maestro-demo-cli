import type { TTSConfig } from '../types.js';
import type { TTSEngine } from './index.js';

export class ElevenLabsEngine implements TTSEngine {
  private config: TTSConfig;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  async generate(text: string, voice: string, _speed: number): Promise<Buffer> {
    // Dynamic import — optional dep, not in devDependencies so skip type-checking
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await (Function('s', 'return import(s)')('@elevenlabs/elevenlabs-js') as Promise<any>);
    const { ElevenLabsClient } = mod;
    const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

    const stream = await client.textToSpeech.convert(voice, {
      text,
      model_id: this.config.elevenLabsModel ?? 'eleven_multilingual_v2',
      output_format: 'pcm_44100',
    });

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const pcm = Buffer.concat(chunks);
    return pcmToWav(pcm, 44100);
  }
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);

  return buffer;
}
