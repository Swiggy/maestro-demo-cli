/**
 * record.ts
 *
 * Runs Maestro with the augmented flow and captures a screen recording.
 *
 * Strategy:
 *   1. Write the augmented flow YAML to a temp file
 *   2. Run `maestro record <flow>` which produces a .mp4 video
 *   3. Build SceneTiming[] from the deterministic sleep durations we injected
 *
 * Because we control the waits via injected `sleep` commands, scene start
 * times are computed deterministically from the TTS durations — no device-side
 * instrumentation required.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import type { RecordResult } from './types.js';
import type { ParsedFlow } from './parse-maestro.js';
import { maestroEnv, maestroBinPath } from './maestro-env.js';
import { buildSceneTimings } from './timeline.js';

export interface RecordOptions {
  /** Absolute path to write the recorded .mp4 */
  outputVideoPath: string;
  /** Maestro device ID (--device flag) */
  deviceId?: string;
  /** Show Maestro output in terminal */
  verbose?: boolean;
}

/**
 * Records a Maestro demo.
 *
 * @param flow          Parsed Maestro flow (needed to resolve scene order)
 * @param augmentedYaml Augmented YAML with injected sleep commands
 * @param ttsDurations  Map of scene name → TTS duration in ms
 * @param options       Recording options
 */
export async function record(
  flow: ParsedFlow,
  augmentedYaml: string,
  ttsDurations: Map<string, number>,
  options: RecordOptions
): Promise<RecordResult> {
  // Write augmented flow to a temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-demo-'));
  const augmentedFlowPath = path.join(tmpDir, 'augmented-flow.yaml');
  fs.writeFileSync(augmentedFlowPath, augmentedYaml, 'utf8');

  const maestro = maestroBinPath() ?? 'maestro';
  const videoOutputPath = path.join(tmpDir, 'recording.mp4');
  const args = ['record', '--local', augmentedFlowPath, videoOutputPath];
  if (options.deviceId) {
    args.push('--device', options.deviceId);
  }

  const env = await maestroEnv();
  process.stdout.write(`  [record] running maestro record...\n`);

  try {
    // reject: false so we can still grab the video even when flow steps fail (exit code 1)
    const result = await execa(maestro, args, {
      stdout: options.verbose ? 'inherit' : 'pipe',
      stderr: options.verbose ? 'inherit' : 'pipe',
      env,
      cwd: tmpDir,
      reject: false,
    });

    // With --local, we passed videoOutputPath explicitly; fall back to search for older Maestro versions.
    const maestroVideo = fs.existsSync(videoOutputPath)
      ? videoOutputPath
      : findMaestroVideo((result as any).stdout ?? '', tmpDir, augmentedFlowPath);
    if (!maestroVideo) {
      // If maestro exited non-zero and no video, surface the actual error
      if ((result as any).exitCode !== 0) {
        throw new Error(`maestro record failed (exit ${(result as any).exitCode}). Enable --verbose for details.`);
      }
      throw new Error('maestro record did not produce a video file. Enable --verbose for details.');
    }

    // Copy to our expected output path
    fs.mkdirSync(path.dirname(options.outputVideoPath), { recursive: true });
    fs.copyFileSync(maestroVideo, options.outputVideoPath);
  } finally {
    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Build deterministic scene timings from TTS durations
  const timings = buildSceneTimings(flow.scenes, ttsDurations);

  return { videoPath: options.outputVideoPath, timings };
}

/**
 * Tries to find the video file produced by `maestro record`.
 * Maestro writes to `<basename>.mp4` in the cwd or prints the path.
 */
function findMaestroVideo(stdout: string, tmpDir: string, flowPath: string): string | null {
  // Check if path is printed in stdout
  const pathMatch = /(?:recording|video|output)[^\n]*?:\s*(.+\.mp4)/i.exec(stdout);
  if (pathMatch) {
    const p = pathMatch[1].trim();
    if (fs.existsSync(p)) return p;
  }

  // Check next to the flow file
  const basename = path.basename(flowPath, '.yaml');
  const candidates = [
    path.join(tmpDir, `${basename}.mp4`),
    path.join(process.cwd(), `${basename}.mp4`),
    path.join(process.cwd(), 'recording.mp4'),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Search cwd for any freshly-created .mp4 (within last 30s)
  const now = Date.now();
  const entries = fs.readdirSync(process.cwd());
  for (const entry of entries) {
    if (!entry.endsWith('.mp4')) continue;
    const stat = fs.statSync(path.join(process.cwd(), entry));
    if (now - stat.mtimeMs < 30_000) return path.join(process.cwd(), entry);
  }

  return null;
}
