import type { TTSConfig } from '../types.js';
import type { TTSEngine } from './index.js';

export class OpenAIEngine implements TTSEngine {
  private config: TTSConfig;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  async generate(text: string, voice: string, speed: number): Promise<Buffer> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await client.audio.speech.create({
      model: (this.config.openaiModel ?? 'tts-1-hd') as 'tts-1' | 'tts-1-hd',
      voice: voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
      input: text,
      speed,
      response_format: 'wav',
    });

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
