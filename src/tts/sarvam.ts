import type { TTSConfig } from '../types.js';
import type { TTSEngine } from './index.js';

export class SarvamEngine implements TTSEngine {
  private config: TTSConfig;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  private async translate(text: string, apiKey: string): Promise<string> {
    const sourceLang = this.config.sarvamSourceLanguageCode ?? 'en-IN';
    const targetLang = this.config.sarvamLanguageCode ?? 'en-IN';

    const response = await fetch('https://api.sarvam.ai/translate', {
      method: 'POST',
      headers: {
        'api-subscription-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        source_language_code: sourceLang,
        target_language_code: targetLang,
        model: 'mayura:v1',
        mode: 'formal',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sarvam translate error ${response.status}: ${body}`);
    }

    const json = (await response.json()) as { translated_text: string };
    return json.translated_text;
  }

  async generate(text: string, voice: string, speed: number): Promise<Buffer> {
    const apiKey = process.env.SARVAM_API_KEY;
    if (!apiKey) throw new Error('SARVAM_API_KEY environment variable is not set');

    const inputText = this.config.sarvamTranslate
      ? await this.translate(text, apiKey)
      : text;

    const response = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'api-subscription-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: inputText,
        target_language_code: this.config.sarvamLanguageCode ?? 'en-IN',
        model: this.config.sarvamModel ?? 'bulbul:v3',
        speaker: voice,
        pace: speed,
        speech_sample_rate: 22050,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sarvam TTS error ${response.status}: ${body}`);
    }

    const json = (await response.json()) as { audios: string[] };
    return Buffer.from(json.audios[0], 'base64');
  }
}
