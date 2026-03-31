/**
 * export.ts
 *
 * Composites the recorded video with TTS audio placements using FFmpeg.
 *
 * Filter graph (applied in order):
 *   1. Tail pad  — extends video if narration overflows
 *   2. Scale     — resize to target dimensions
 *   3. Speed ramp — accelerate silent gaps between voiced scenes
 *   4. Audio mix — overlay each TTS clip at its placement time
 *   5. Loudnorm  — EBU R128 normalization (optional)
 *   6. Sharpen   — contrast-adaptive sharpening (optional)
 *   7. Watermark — composited over video (optional)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import type { Placement, AudioPlacement, ExportConfig, VideoConfig } from './types.js';
import { computeTailPad } from './timeline.js';

export interface ExportOptions {
  videoPath: string;
  outputPath: string;
  placements: Placement[];
  recordedDurationMs: number;
  videoConfig: VideoConfig;
  exportConfig: ExportConfig;
}

export async function exportVideo(opts: ExportOptions): Promise<void> {
  const { videoPath, outputPath, placements, recordedDurationMs, videoConfig, exportConfig } = opts;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const tailPadMs = computeTailPad(placements, recordedDurationMs);
  const audioPlacements = placements.filter((p): p is AudioPlacement => 'audioPath' in p);

  const args = buildFfmpegArgs({
    videoPath,
    outputPath,
    placements: audioPlacements,
    tailPadMs,
    tailPadFromConfig: exportConfig.tailPadMs ?? 800,
    videoConfig,
    exportConfig,
  });

  process.stdout.write(`  [export] running ffmpeg...\n`);

  await execa('ffmpeg', args, { stderr: 'inherit' });

  process.stdout.write(`  [export] wrote ${outputPath}\n`);

  // Optional GIF
  if (exportConfig.formats?.includes('gif')) {
    await exportGif(outputPath, exportConfig);
  }
}

// ─── FFmpeg argument builder ───────────────────────────────────────────────

interface FfmpegBuildArgs {
  videoPath: string;
  outputPath: string;
  placements: AudioPlacement[];
  tailPadMs: number;
  tailPadFromConfig: number;
  videoConfig: VideoConfig;
  exportConfig: ExportConfig;
}

function buildFfmpegArgs(args: FfmpegBuildArgs): string[] {
  const { videoPath, outputPath, placements, tailPadMs, tailPadFromConfig, videoConfig, exportConfig } = args;

  const totalTailPadMs = tailPadMs + tailPadFromConfig;
  const { width, height, fps } = videoConfig;
  const { crf, preset, audio, watermark, sharpen } = exportConfig;

  const inputs: string[] = ['-i', videoPath];
  const audioInputIndices: number[] = [];

  for (let i = 0; i < placements.length; i++) {
    inputs.push('-i', placements[i].audioPath);
    audioInputIndices.push(i + 1); // video is input 0
  }

  const filterParts: string[] = [];

  // ── Video chain ────────────────────────────────────────────────────────
  let videoLabel = '[0:v]';

  // Tail pad
  if (totalTailPadMs > 0) {
    const padFrames = Math.ceil((totalTailPadMs / 1000) * fps);
    filterParts.push(`${videoLabel}tpad=stop_mode=clone:stop=${padFrames}[vpad]`);
    videoLabel = '[vpad]';
  }

  // Crop (extract app screen from raw recording before scaling)
  if (videoConfig.crop) {
    const { x, y, width: cw, height: ch } = videoConfig.crop;
    filterParts.push(`${videoLabel}crop=${cw}:${ch}:${x}:${y}[vcrop]`);
    videoLabel = '[vcrop]';
  }

  // Scale — use width:-2 to preserve aspect ratio (avoids distortion when crop and
  // output aspect ratios differ). The -2 ensures height stays divisible by 2 for yuv420p.
  filterParts.push(`${videoLabel}scale=${width}:-2:flags=lanczos[vscale]`);
  videoLabel = '[vscale]';

  // Sharpen — unsharp is more effective than CAS for screen recording content
  // (sharp UI edges, text, icons). Default strength 1.0 gives a noticeable improvement
  // on the small crops produced by Maestro's local recorder.
  if (sharpen) {
    const strength = typeof sharpen === 'object' ? sharpen.strength : 1.0;
    filterParts.push(`${videoLabel}unsharp=luma_msize_x=3:luma_msize_y=3:luma_amount=${strength}[vsharp]`);
    videoLabel = '[vsharp]';
  }

  // Watermark overlay
  if (watermark?.src && fs.existsSync(watermark.src)) {
    const wmIdx = placements.length + 1;
    inputs.push('-i', watermark.src);
    const pos = resolveWatermarkPosition(watermark.position, watermark.margin ?? 20);
    const opacity = watermark.opacity ?? 0.7;
    filterParts.push(
      `${videoLabel}[${wmIdx}:v]overlay=${pos}:alpha=${opacity}[vwm]`
    );
    videoLabel = '[vwm]';
  }

  filterParts.push(`${videoLabel}copy[vout]`);

  // ── Audio chain ────────────────────────────────────────────────────────
  let audioLabel: string;

  if (placements.length === 0) {
    // No narration — silence
    filterParts.push(`aevalsrc=0:c=mono:s=44100:d=10[aout]`);
    audioLabel = '[aout]';
  } else {
    // Delay each audio clip to its placement time
    const delayedLabels: string[] = [];
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      const delayMs = Math.round(p.startMs);
      const label = `[a${i}d]`;
      filterParts.push(`[${audioInputIndices[i]}:a]adelay=${delayMs}:all=1${label}`);
      delayedLabels.push(label);
    }

    // Mix all delayed clips — duration=longest keeps mixing until the last clip ends
    const mixIn = delayedLabels.join('');
    filterParts.push(`${mixIn}amix=inputs=${placements.length}:normalize=0:duration=longest[amix]`);
    audioLabel = '[amix]';

    // Loudness normalization — introduces a ~3s latency so only run when explicitly enabled
    if (audio?.loudnorm === true) {
      filterParts.push(`${audioLabel}loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
      audioLabel = '[aout]';
    } else {
      filterParts.push(`${audioLabel}acopy[aout]`);
      audioLabel = '[aout]';
    }

    // Background music
    if (audio?.music && fs.existsSync(audio.music)) {
      const musicIdx = placements.length + (watermark?.src ? 2 : 1);
      inputs.push('-i', audio.music);
      const vol = audio.musicVolume ?? 0.12;
      filterParts.push(
        `${audioLabel}[${musicIdx}:a]volume=${vol}[music];[aout][music]amix=inputs=2:normalize=0[afinal]`
      );
      audioLabel = '[afinal]';
    }
  }

  const filterComplex = filterParts.join(';');

  return [
    '-y',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', audioLabel,
    '-c:v', 'libx264',
    '-crf', String(crf ?? 18),
    '-preset', preset ?? 'slow',
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    outputPath,
  ];
}

function resolveWatermarkPosition(
  position: string = 'bottom-right',
  margin: number
): string {
  switch (position) {
    case 'top-left':     return `${margin}:${margin}`;
    case 'top-right':    return `main_w-overlay_w-${margin}:${margin}`;
    case 'bottom-left':  return `${margin}:main_h-overlay_h-${margin}`;
    case 'bottom-right':
    default:             return `main_w-overlay_w-${margin}:main_h-overlay_h-${margin}`;
  }
}

async function exportGif(mp4Path: string, config: ExportConfig): Promise<void> {
  const gifPath = mp4Path.replace(/\.mp4$/, '.gif');
  const palette = mp4Path.replace(/\.mp4$/, '-palette.png');

  // Two-pass GIF
  await execa('ffmpeg', [
    '-y', '-i', mp4Path,
    '-vf', 'fps=12,scale=480:-1:flags=lanczos,palettegen',
    palette,
  ]);
  await execa('ffmpeg', [
    '-y', '-i', mp4Path, '-i', palette,
    '-filter_complex', 'fps=12,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse',
    gifPath,
  ]);
  fs.rmSync(palette, { force: true });
  process.stdout.write(`  [export] wrote ${gifPath}\n`);
}
