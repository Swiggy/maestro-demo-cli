/**
 * detect-crop.ts
 *
 * Automatically detects the app screen region within a Maestro raw recording.
 *
 * Maestro's --local recording captures the full emulator window: the Maestro
 * terminal log on the left (dark background) and the phone simulator on the
 * right (bright/white background). This module finds the bright rectangular
 * region (the phone screen) by scanning pixel brightness.
 *
 * Strategy:
 *   1. Extract one representative frame from the video as raw RGB via ffmpeg
 *   2. Scan multiple horizontal rows to find where the bright phone region starts/ends
 *   3. Scan vertically inside that region to find top/bottom edges
 *   4. Return crop coordinates, or null if detection fails
 */

import { execa } from 'execa';
import type { CropConfig } from './types.js';

const BRIGHTNESS_THRESHOLD = 220; // 0–255; app screen is near-white (~250), device chrome/gradient is ~160-200, terminal is dark (~10)
const SCAN_ROWS = 5; // number of rows to sample for robustness

export async function detectCrop(rawVideoPath: string): Promise<CropConfig | null> {
  // ── Get frame dimensions ──────────────────────────────────────────────────
  const probeResult = await execa('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', rawVideoPath,
  ]);
  const info = JSON.parse(probeResult.stdout) as { streams: Array<{ codec_type: string; width: number; height: number }> };
  const stream = info.streams.find((s) => s.codec_type === 'video');
  if (!stream) return null;

  const W = stream.width;
  const H = stream.height;

  // ── Extract one frame as raw RGB bytes ────────────────────────────────────
  // Seek to 1s in to avoid black leader frames
  const frameResult = await execa('ffmpeg', [
    '-ss', '1',
    '-i', rawVideoPath,
    '-vframes', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ], { encoding: 'buffer', stderr: 'ignore' });

  const pixels = frameResult.stdout as unknown as Buffer;
  if (pixels.length < W * H * 3) return null;

  function brightness(x: number, y: number): number {
    const idx = (y * W + x) * 3;
    return (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
  }

  // ── Find left/right edges by scanning multiple horizontal rows ────────────
  // Sample rows at 25%, 37.5%, 50%, 62.5%, 75% height
  const sampleRows = Array.from({ length: SCAN_ROWS }, (_, i) =>
    Math.floor(H * (0.25 + i * 0.125))
  );

  let left = -1;
  let right = -1;

  for (const y of sampleRows) {
    // Scan right-to-left to find rightmost bright zone first (phone is on right)
    let rEdge = -1;
    for (let x = W - 1; x >= 0; x--) {
      if (brightness(x, y) > BRIGHTNESS_THRESHOLD) { rEdge = x; break; }
    }
    if (rEdge === -1) continue;

    // Scan right-to-left from rEdge to find where bright region starts (left edge)
    let lEdge = rEdge;
    for (let x = rEdge - 1; x >= 0; x--) {
      if (brightness(x, y) <= BRIGHTNESS_THRESHOLD) { lEdge = x + 1; break; }
    }

    if (right === -1) {
      right = rEdge;
      left = lEdge;
    } else {
      // Take the consensus: use the most common left edge (median-ish)
      left = Math.min(left, lEdge);
      right = Math.max(right, rEdge);
    }
  }

  if (left === -1 || right === -1 || right - left < 50) return null;

  // ── Find top/bottom edges by scanning vertically at center of bright zone ─
  const midX = Math.floor((left + right) / 2);

  let top = -1;
  for (let y = 0; y < H; y++) {
    if (brightness(midX, y) > BRIGHTNESS_THRESHOLD) { top = y; break; }
  }

  let bottom = -1;
  for (let y = H - 1; y >= 0; y--) {
    if (brightness(midX, y) > BRIGHTNESS_THRESHOLD) { bottom = y; break; }
  }

  if (top === -1 || bottom === -1 || bottom - top < 50) return null;

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Extracts a single cropped frame to a PNG file for visual verification.
 */
export async function extractCroppedFrame(
  rawVideoPath: string,
  crop: CropConfig,
  outputPng: string,
): Promise<void> {
  await execa('ffmpeg', [
    '-y', '-ss', '1',
    '-i', rawVideoPath,
    '-vframes', '1',
    '-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    outputPng,
  ], { stderr: 'ignore' });
}
