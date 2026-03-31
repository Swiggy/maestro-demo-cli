import { Worker } from 'worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TTSEngine } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class KokoroEngine implements TTSEngine {
  async generate(text: string, voice: string, speed: number): Promise<Buffer> {
    // Run in a Worker thread to avoid phonemizer WASM pthreads conflicting
    // with mutex state inherited from a parent Node.js process (macOS ARM SIGABRT).
    const workerPath = path.join(__dirname, 'kokoro-worker.js');

    return new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: { text, voice, speed },
      });

      worker.on('message', (msg: { wav: ArrayBuffer }) => {
        resolve(Buffer.from(msg.wav));
      });

      worker.on('error', reject);

      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(
            `Kokoro worker exited with code ${code}. ` +
            `If you see phonemizer WASM errors, switch to openai or elevenlabs engine ` +
            `in maestro-demo.config.json.`
          ));
        }
      });
    });
  }
}

/**
 * Checks whether the runtime environment is likely to support Kokoro TTS.
 * Node 20+ is required on ARM macOS for the phonemizer WASM to work.
 */
export function kokoroLikelyWorks(): { ok: boolean; reason: string } {
  const major = parseInt(process.version.slice(1).split('.')[0], 10);
  if (major < 20) {
    return {
      ok: false,
      reason: `Node ${process.version} — phonemizer WASM requires Node ≥ 20 on ARM macOS`,
    };
  }
  return { ok: true, reason: `Node ${process.version}` };
}
