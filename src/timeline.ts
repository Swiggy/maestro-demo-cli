/**
 * timeline.ts
 *
 * Converts scene timings + TTS results into a list of audio placements.
 * Each placement describes exactly when a WAV file should start in the
 * final composite video.
 */

import type { SceneTiming, AudioPlacement, SilentPlacement, Placement } from './types.js';
import type { TTSResult } from './tts/index.js';

const LEAD_IN_MS = 200;

const STEP_OFFSET_MS = 300; // rough time budget for each action step before narration starts
const TIMING_LEAD_IN_MS = 500; // initial app-launch buffer

/**
 * Builds deterministic scene timings from TTS durations.
 * Each scene starts after: lead-in + sum of all previous TTS durations + N * STEP_OFFSET_MS.
 * Used both when computing timings from a live recording and when reconstructing from cache.
 */
export function buildSceneTimings(
  scenes: Array<{ name: string }>,
  ttsDurations: Map<string, number>
): SceneTiming[] {
  const timings: SceneTiming[] = [];
  let cursor = TIMING_LEAD_IN_MS;

  for (const scene of scenes) {
    const durationMs = ttsDurations.get(scene.name) ?? 0;
    timings.push({ scene: scene.name, startMs: cursor, endMs: cursor + durationMs });
    cursor += durationMs + STEP_OFFSET_MS;
  }

  return timings;
}

export interface TimelineOptions {
  /** Extra ms to add after the last audio clip */
  tailPadMs?: number;
}

export function buildPlacements(
  timings: SceneTiming[],
  ttsResults: Map<string, TTSResult>,
  options: TimelineOptions = {}
): Placement[] {
  const placements: Placement[] = [];

  for (const timing of timings) {
    const tts = ttsResults.get(timing.scene);
    if (!tts) {
      // Silent scene — no audio
      const p: SilentPlacement = {
        scene: timing.scene,
        startMs: timing.startMs,
        endMs: timing.endMs,
      };
      placements.push(p);
      continue;
    }

    // Place audio with a small lead-in so narration starts just after the
    // visual action (tap, input) completes.
    const audioStart = timing.startMs + LEAD_IN_MS;
    const p: AudioPlacement = {
      scene: timing.scene,
      audioPath: tts.wavPath,
      startMs: audioStart,
      endMs: audioStart + tts.durationMs,
      durationMs: tts.durationMs,
    };
    placements.push(p);
  }

  return placements.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Computes the total video duration needed to fit all placements.
 */
export function computeTotalDurationMs(
  placements: Placement[],
  recordedDurationMs: number,
  tailPadMs = 800
): number {
  const lastEnd = placements.reduce((max, p) => Math.max(max, p.endMs), 0);
  return Math.max(recordedDurationMs, lastEnd) + tailPadMs;
}

/**
 * If the last placement overflows past the video length, returns how many ms
 * the video tail needs to be padded.
 */
export function computeTailPad(placements: Placement[], recordedDurationMs: number): number {
  const lastEnd = placements.reduce((max, p) => Math.max(max, p.endMs), 0);
  return Math.max(0, lastEnd - recordedDurationMs + 200);
}

/**
 * Generates a human-readable scene report (printed to stdout after pipeline).
 */
export function formatSceneReport(
  placements: Placement[],
  ttsResults: Map<string, TTSResult>
): string {
  const lines = ['', '  Scene Report:', '  ' + '─'.repeat(60)];

  for (const p of placements) {
    const tts = ttsResults.get(p.scene);
    const start = formatMs(p.startMs);
    const end = formatMs(p.endMs);
    const dur = tts ? `${tts.durationMs.toFixed(0)}ms TTS` : 'silent';
    lines.push(`  ${p.scene.padEnd(30)} ${start} → ${end}  (${dur})`);
  }

  lines.push('');
  return lines.join('\n');
}

function formatMs(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${m}:${sec}`;
}
