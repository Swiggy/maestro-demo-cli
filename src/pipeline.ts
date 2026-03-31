/**
 * pipeline.ts
 *
 * Orchestrates the full maestro-demo pipeline:
 *   1. Parse flow YAML + scenes manifest
 *   2. Generate TTS clips
 *   3. Build augmented flow with sleep injections
 *   4. Record with Maestro
 *   5. Build timeline placements
 *   6. Export final video with FFmpeg
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MaestroConfig } from './types.js';
import { demoWorkDir, outputDir } from './config.js';
import {
  parseFlow,
  buildAugmentedFlow,
  extractSceneNames,
  extractInlineNarrations,
} from './parse-maestro.js';
import { generateTTSClips } from './tts/index.js';
import { record } from './record.js';
import { buildPlacements, buildSceneTimings, computeTotalDurationMs, formatSceneReport } from './timeline.js';
import { exportVideo } from './export.js';

export interface PipelineOptions {
  deviceId?: string;
  verbose?: boolean;
  /** Skip TTS generation (use cached clips) */
  skipTts?: boolean;
  /** Skip recording (use cached video) */
  skipRecord?: boolean;
}

export async function runPipeline(
  demoName: string,
  config: MaestroConfig,
  pipelineOpts: PipelineOptions = {},
  projectRoot = process.cwd()
): Promise<string> {
  const workDir = demoWorkDir(demoName, config, projectRoot);

  // ── 1. Resolve flow and manifest ─────────────────────────────────────────
  const flowPath = findFlowFile(workDir, demoName);
  if (!flowPath) {
    throw new Error(`No Maestro flow found in ${workDir}. Expected ${demoName}.yaml or flow.yaml`);
  }

  process.stdout.write(`\n[maestro-demo] pipeline: ${demoName}\n`);
  process.stdout.write(`  flow: ${flowPath}\n`);

  const flow = parseFlow(flowPath);

  // Read scenes and narration directly from the YAML flow
  const inlineNarrations = extractInlineNarrations(flow);
  const scenes = extractSceneNames(flow).map((name) => ({
    scene: name,
    text: inlineNarrations.get(name),
  }));

  process.stdout.write(`  scenes: ${scenes.map((s) => s.scene).join(', ')}\n\n`);

  // ── 2. TTS generation ─────────────────────────────────────────────────────
  const ttsDir = path.join(workDir, '.maestro-demo', 'tts');
  let ttsResults = new Map<string, import('./tts/index.js').TTSResult>();

  if (!pipelineOpts.skipTts) {
    process.stdout.write(`[step 1/4] generating TTS...\n`);
    ttsResults = await generateTTSClips(scenes, config.tts, ttsDir);
  } else {
    ttsResults = loadCachedTts(ttsDir, scenes);
  }

  // ── 3. Build augmented flow ───────────────────────────────────────────────
  const ttsDurations = new Map(
    Array.from(ttsResults.entries()).map(([name, r]) => [name, r.durationMs])
  );

  process.stdout.write(`[step 2/4] building augmented flow...\n`);
  const augmentedYaml = buildAugmentedFlow(flow, ttsDurations);
  const augmentedPath = path.join(workDir, '.maestro-demo', 'augmented-flow.yaml');
  fs.mkdirSync(path.dirname(augmentedPath), { recursive: true });
  fs.writeFileSync(augmentedPath, augmentedYaml, 'utf8');

  // ── 4. Record ─────────────────────────────────────────────────────────────
  const videoDir = path.join(workDir, '.maestro-demo');
  const rawVideoPath = path.join(videoDir, 'raw.mp4');

  let recordResult: import('./types.js').RecordResult;

  if (!pipelineOpts.skipRecord && !fs.existsSync(rawVideoPath)) {
    process.stdout.write(`[step 3/4] recording with Maestro...\n`);
    recordResult = await record(flow, augmentedYaml, ttsDurations, {
      outputVideoPath: rawVideoPath,
      deviceId: pipelineOpts.deviceId,
      verbose: pipelineOpts.verbose,
    });
  } else {
    process.stdout.write(`[step 3/4] using cached recording at ${rawVideoPath}\n`);
    recordResult = {
      videoPath: rawVideoPath,
      timings: buildSceneTimings(flow.scenes, ttsDurations),
    };
  }

  // ── 5. Build timeline ─────────────────────────────────────────────────────
  const placements = buildPlacements(recordResult.timings, ttsResults);

  // Estimate recorded video duration (we'll use ffprobe if available)
  const recordedDurationMs = await probeVideoDurationMs(recordResult.videoPath);

  // ── 6. Export ─────────────────────────────────────────────────────────────
  process.stdout.write(`[step 4/4] exporting video...\n`);
  const outDir = outputDir(config, projectRoot);
  const outputPath = path.join(outDir, `${demoName}.mp4`);

  await exportVideo({
    videoPath: recordResult.videoPath,
    outputPath,
    placements,
    recordedDurationMs,
    videoConfig: config.video,
    exportConfig: config.export,
  });

  // ── Report ────────────────────────────────────────────────────────────────
  const totalMs = computeTotalDurationMs(placements, recordedDurationMs, config.export.tailPadMs);
  process.stdout.write(formatSceneReport(placements, ttsResults));
  process.stdout.write(`\n[maestro-demo] done! Total duration: ${(totalMs / 1000).toFixed(1)}s\n`);
  process.stdout.write(`  output: ${outputPath}\n\n`);

  return outputPath;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function findFlowFile(workDir: string, demoName: string): string | null {
  const candidates = [
    path.join(workDir, `${demoName}.yaml`),
    path.join(workDir, 'flow.yaml'),
    path.join(workDir, `${demoName}.yml`),
    path.join(workDir, 'flow.yml'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function loadCachedTts(
  ttsDir: string,
  scenes: import('./types.js').SceneEntry[]
): Map<string, import('./tts/index.js').TTSResult> {
  const results = new Map<string, import('./tts/index.js').TTSResult>();
  if (!fs.existsSync(ttsDir)) return results;

  for (const scene of scenes) {
    const files = fs.readdirSync(ttsDir).filter((f) => f.startsWith(`${scene.scene}__`) && f.endsWith('.wav'));
    if (files.length > 0) {
      const wavPath = path.join(ttsDir, files[0]);
      const buf = fs.readFileSync(wavPath);
      // Parse duration from WAV header: sampleRate at offset 24, byteRate at 28, dataSize at 40
      const byteRate = buf.readUInt32LE(28);
      const dataSize = buf.readUInt32LE(40);
      const durationMs = byteRate > 0 ? (dataSize / byteRate) * 1000 : 0;
      results.set(scene.scene, { wavPath, durationMs });
    }
  }
  return results;
}

async function probeVideoDurationMs(videoPath: string): Promise<number> {
  try {
    const { execa } = await import('execa');
    const result = await execa('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      videoPath,
    ]);
    const json = JSON.parse(result.stdout) as { format: { duration: string } };
    return parseFloat(json.format.duration) * 1000;
  } catch {
    return 30_000; // fallback
  }
}
