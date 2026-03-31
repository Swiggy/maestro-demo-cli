/**
 * tts/index.ts
 *
 * TTS engine abstraction. Each engine takes text + voice and returns a WAV
 * buffer. Results are cached by content hash to avoid regeneration.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { TTSConfig, SceneEntry } from '../types.js';

export interface TTSResult {
  wavPath: string;
  durationMs: number;
}

export interface TTSEngine {
  generate(text: string, voice: string, speed: number): Promise<Buffer>;
}

// ─── WAV header parsing ────────────────────────────────────────────────────

export function parseWavDuration(buf: Buffer): number {
  // WAV: RIFF header at offset 0, data subchunk starts at offset 44 (PCM)
  if (buf.length < 44) return 0;
  const sampleRate = buf.readUInt32LE(24);
  const byteRate = buf.readUInt32LE(28);
  if (byteRate === 0) return 0;
  // Find 'data' subchunk
  const dataSize = buf.readUInt32LE(40);
  return (dataSize / byteRate) * 1000;
}

// ─── Cache helpers ─────────────────────────────────────────────────────────

function cacheKey(text: string, voice: string, speed: number, engine: string): string {
  return crypto
    .createHash('sha1')
    .update(`${engine}:${voice}:${speed}:${text}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── Main generate function ────────────────────────────────────────────────

export async function generateTTSClips(
  scenes: SceneEntry[],
  config: TTSConfig,
  cacheDir: string
): Promise<Map<string, TTSResult>> {
  fs.mkdirSync(cacheDir, { recursive: true });

  const engine = await loadEngine(config);
  const results = new Map<string, TTSResult>();

  for (const scene of scenes) {
    if (scene.silent || !scene.text?.trim()) {
      continue;
    }

    const voice = scene.voice ?? config.defaultVoice;
    const speed = scene.speed ?? config.defaultSpeed;
    const text = scene.text.trim();
    const key = cacheKey(text, voice, speed, config.engine);
    const wavPath = path.join(cacheDir, `${scene.scene}__${key}.wav`);

    if (!fs.existsSync(wavPath)) {
      process.stdout.write(`  [tts] generating "${scene.scene}"...\n`);
      const buf = await engine.generate(text, voice, speed);
      fs.writeFileSync(wavPath, buf);
    }

    const buf = fs.readFileSync(wavPath);
    const durationMs = parseWavDuration(buf);
    results.set(scene.scene, { wavPath, durationMs });
  }

  return results;
}

async function loadEngine(config: TTSConfig): Promise<TTSEngine> {
  switch (config.engine) {
    case 'kokoro': {
      const { KokoroEngine } = await import('./kokoro.js');
      return new KokoroEngine();
    }
    case 'openai': {
      const { OpenAIEngine } = await import('./openai.js');
      return new OpenAIEngine(config);
    }
    case 'elevenlabs': {
      const { ElevenLabsEngine } = await import('./elevenlabs.js');
      return new ElevenLabsEngine(config);
    }
    case 'sarvam': {
      const { SarvamEngine } = await import('./sarvam.js');
      return new SarvamEngine(config);
    }
    default:
      throw new Error(`Unknown TTS engine: ${(config as TTSConfig).engine}`);
  }
}
