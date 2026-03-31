/**
 * kokoro-worker.ts
 *
 * Runs inside a Node.js Worker thread so that the phonemizer WASM pthreads
 * don't conflict with mutex state inherited from a parent Node.js process
 * (which causes SIGABRT on macOS ARM).
 */

import { parentPort, workerData } from 'worker_threads';

interface WorkerInput {
  text: string;
  voice: string;
  speed: number;
}

const { text, voice, speed } = workerData as WorkerInput;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { KokoroTTS } = await import('kokoro-js') as any;
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
  dtype: 'q8',
  device: 'cpu',
});

const audio = await tts.generate(text, { voice, speed });

// toWav() returns a valid WAV ArrayBuffer — transfer it (zero-copy) back to main thread
const wavBuffer = audio.toWav() as ArrayBuffer;
parentPort!.postMessage({ wav: wavBuffer }, [wavBuffer]);
