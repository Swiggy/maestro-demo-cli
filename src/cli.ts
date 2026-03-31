#!/usr/bin/env node
/**
 * cli.ts — maestro-demo CLI entry point
 *
 * Commands:
 *   pipeline <demo>   Full pipeline: TTS → record → export
 *   tts <demo>        Generate TTS clips only
 *   record <demo>     Record with Maestro only (uses cached TTS)
 *   export <demo>     Export video only (uses cached recording)
 *   validate <demo>   Validate flow and manifest
 *   doctor            Check the environment setup
 *   init              Scaffold new project / convert existing flow
 */

import { program } from 'commander';
import chalk from 'chalk';
import { loadConfig } from './config.js';
import { runPipeline } from './pipeline.js';
import { validateDemo } from './validate.js';
import { runDoctor, formatDoctorResults } from './doctor.js';
import { initProject } from './init.js';
import { generateTTSClips } from './tts/index.js';
import {
  parseFlow,
  extractSceneNames,
  extractInlineNarrations,
  buildAugmentedFlow,
} from './parse-maestro.js';
import { record } from './record.js';
import { buildPlacements, buildSceneTimings, formatSceneReport } from './timeline.js';
import { exportVideo } from './export.js';
import { detectCrop, extractCroppedFrame } from './detect-crop.js';
import { execa } from 'execa';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VERSION = '0.1.0';

program
  .name('maestro-demo')
  .description('Turn Maestro mobile test flows into polished demo videos with AI voiceover')
  .version(VERSION)
  .option('-c, --config <path>', 'path to config file');

// ── pipeline ────────────────────────────────────────────────────────────────

program
  .command('pipeline [demo]')
  .description('Run full pipeline: TTS → record → export')
  .option('--device <id>', 'Maestro device ID')
  .option('--all', 'Process all demos in demosDir')
  .option('--skip-tts', 'Skip TTS generation (use cached clips)')
  .option('--skip-record', 'Skip recording (use existing raw.mp4)')
  .option('--verbose', 'Show Maestro output')
  .action(async (demo: string | undefined, opts) => {
    const config = loadConfig(program.opts().config);

    if (opts.all) {
      const demosBase = path.resolve(config.demosDir);
      if (!fs.existsSync(demosBase)) {
        die(`demosDir not found: ${demosBase}`);
      }
      const names = fs.readdirSync(demosBase).filter((d) =>
        fs.statSync(path.join(demosBase, d)).isDirectory()
      );
      if (names.length === 0) die('No demo directories found');
      for (const name of names) {
        await runPipeline(name, config, {
          deviceId: opts.device,
          verbose: opts.verbose,
          skipTts: opts.skipTts,
          skipRecord: opts.skipRecord,
        });
      }
    } else {
      if (!demo) die('Usage: maestro-demo pipeline <demo>');
      await runPipeline(demo, config, {
        deviceId: opts.device,
        verbose: opts.verbose,
        skipTts: opts.skipTts,
        skipRecord: opts.skipRecord,
      });
    }
  });

// ── tts ─────────────────────────────────────────────────────────────────────

program
  .command('tts <demo>')
  .description('Generate TTS audio clips only')
  .action(async (demo: string) => {
    const config = loadConfig(program.opts().config);
    const workDir = path.join(path.resolve(config.demosDir), demo);
    const flowPath = findFlow(workDir, demo);
    const flow = parseFlow(flowPath);
    const scenes = loadScenes(workDir, demo, flow);
    const ttsDir = path.join(workDir, '.maestro-demo', 'tts');

    process.stdout.write(`\n[maestro-demo] generating TTS for ${demo}...\n`);
    const results = await generateTTSClips(scenes, config.tts, ttsDir);
    for (const [name, r] of results) {
      process.stdout.write(`  ${name}: ${r.durationMs.toFixed(0)}ms → ${r.wavPath}\n`);
    }
  });

// ── record ──────────────────────────────────────────────────────────────────

program
  .command('record <demo>')
  .description('Record Maestro demo (uses cached TTS for sleep injection)')
  .option('--device <id>', 'Maestro device ID')
  .option('--verbose', 'Show Maestro output')
  .action(async (demo: string, opts) => {
    const config = loadConfig(program.opts().config);
    const workDir = path.join(path.resolve(config.demosDir), demo);
    const flowPath = findFlow(workDir, demo);
    const flow = parseFlow(flowPath);
    const scenes = loadScenes(workDir, demo, flow);
    const ttsDir = path.join(workDir, '.maestro-demo', 'tts');

    const ttsResults = await generateTTSClips(scenes, config.tts, ttsDir);
    const ttsDurations = new Map(Array.from(ttsResults.entries()).map(([k, v]) => [k, v.durationMs]));
    const augmentedYaml = buildAugmentedFlow(flow, ttsDurations);
    const rawVideoPath = path.join(workDir, '.maestro-demo', 'raw.mp4');

    await record(flow, augmentedYaml, ttsDurations, {
      outputVideoPath: rawVideoPath,
      deviceId: opts.device,
      verbose: opts.verbose,
    });

    process.stdout.write(`\n[maestro-demo] recorded: ${rawVideoPath}\n`);
  });

// ── export ──────────────────────────────────────────────────────────────────

program
  .command('export <demo>')
  .description('Export video from cached recording (does not re-record)')
  .action(async (demo: string) => {
    const config = loadConfig(program.opts().config);
    const workDir = path.join(path.resolve(config.demosDir), demo);
    const rawVideoPath = path.join(workDir, '.maestro-demo', 'raw.mp4');

    if (!fs.existsSync(rawVideoPath)) {
      die(`No cached recording found at ${rawVideoPath}. Run "record" first.`);
    }

    const flowPath = findFlow(workDir, demo);
    const flow = parseFlow(flowPath);
    const scenes = loadScenes(workDir, demo, flow);
    const ttsDir = path.join(workDir, '.maestro-demo', 'tts');
    const ttsResults = await generateTTSClips(scenes, config.tts, ttsDir);

    const ttsDurations = new Map(Array.from(ttsResults.entries()).map(([k, v]) => [k, v.durationMs]));
    const timings = buildSceneTimings(flow.scenes, ttsDurations);
    const placements = buildPlacements(timings, ttsResults);
    const outputPath = path.join(path.resolve(config.outputDir), `${demo}.mp4`);

    const { execa } = await import('execa');
    let recordedDurationMs = 30_000;
    try {
      const probe = await execa('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', rawVideoPath]);
      const json = JSON.parse(probe.stdout) as { format: { duration: string } };
      recordedDurationMs = parseFloat(json.format.duration) * 1000;
    } catch { /* use fallback */ }

    await exportVideo({
      videoPath: rawVideoPath,
      outputPath,
      placements,
      recordedDurationMs,
      videoConfig: config.video,
      exportConfig: config.export,
    });

    process.stdout.write(formatSceneReport(placements, ttsResults));
  });

// ── validate ────────────────────────────────────────────────────────────────

program
  .command('validate <demo>')
  .description('Validate flow YAML and scenes manifest')
  .action((demo: string) => {
    const config = loadConfig(program.opts().config);
    const result = validateDemo(demo, config);

    process.stdout.write(`\n[maestro-demo] validating ${demo}...\n`);

    for (const w of result.warnings) {
      process.stdout.write(chalk.yellow(`  ⚠  ${w}\n`));
    }
    for (const e of result.errors) {
      process.stdout.write(chalk.red(`  ✗  ${e}\n`));
    }

    if (result.ok && result.warnings.length === 0) {
      process.stdout.write(chalk.green(`  ✓  All good!\n`));
    } else if (result.ok) {
      process.stdout.write(chalk.yellow(`\n  Validation passed with warnings.\n`));
    } else {
      process.stdout.write(chalk.red(`\n  Validation failed.\n`));
      process.exit(1);
    }
  });

// ── doctor ──────────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Check environment setup (ffmpeg, maestro, TTS engines)')
  .action(async () => {
    const config = loadConfig(program.opts().config);
    const checks = await runDoctor(config);
    process.stdout.write(formatDoctorResults(checks));
    if (checks.some((c) => !c.ok && isRequired(c.name))) process.exit(1);
  });

// ── detect-crop ─────────────────────────────────────────────────────────────

program
  .command('detect-crop <demo>')
  .description('Auto-detect app screen crop from a raw recording and save to config')
  .option('--preview', 'Open a cropped preview frame after detection')
  .action(async (demo: string, opts) => {
    const configPath = program.opts().config ?? 'maestro-demo.config.json';
    const config = loadConfig(configPath);
    const workDir = path.join(path.resolve(config.demosDir), demo);
    const rawVideoPath = path.join(workDir, '.maestro-demo', 'raw.mp4');

    if (!fs.existsSync(rawVideoPath)) {
      die(`No raw recording found at ${rawVideoPath}. Run "record" or "pipeline" first.`);
    }

    process.stdout.write(`\n[maestro-demo] detecting crop for ${demo}...\n`);
    process.stdout.write(`  source: ${rawVideoPath}\n`);

    const crop = await detectCrop(rawVideoPath);
    if (!crop) {
      die('Could not detect the app screen. The recording may lack a clear bright region.\nSet crop coordinates manually in maestro-demo.config.json.');
    }

    process.stdout.write(`  detected: x=${crop.x}, y=${crop.y}, width=${crop.width}, height=${crop.height}\n`);

    // Write detected crop back into the config file
    const resolvedConfigPath = path.resolve(configPath);
    if (fs.existsSync(resolvedConfigPath)) {
      const raw = fs.readFileSync(resolvedConfigPath, 'utf8');
      const json = JSON.parse(raw);
      json.video = { ...json.video, crop };
      fs.writeFileSync(resolvedConfigPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
      process.stdout.write(`  saved to: ${resolvedConfigPath}\n`);
    } else {
      process.stdout.write(`\n  Add this to your maestro-demo.config.json under "video":\n`);
      process.stdout.write(`  ${JSON.stringify({ crop }, null, 2)}\n`);
    }

    // Optional: extract a cropped preview frame
    if (opts.preview) {
      const previewPath = path.join(os.tmpdir(), `maestro-demo-crop-preview.png`);
      await extractCroppedFrame(rawVideoPath, crop, previewPath);
      process.stdout.write(`  preview: ${previewPath}\n`);
      await execa('open', [previewPath], { reject: false });
    }

    process.stdout.write(`\nRun "maestro-demo export ${demo}" to re-export with the new crop.\n\n`);
  });

// ── init ────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold a new maestro-demo project or convert an existing flow')
  .option('--from <path>', 'convert an existing Maestro flow file')
  .option('--demo <name>', 'demo name')
  .action((opts) => {
    process.stdout.write(`\n[maestro-demo] initializing project...\n\n`);
    initProject({ from: opts.from, name: opts.demo });
  });

program.parse();

// ─── Helpers ───────────────────────────────────────────────────────────────

function die(msg: string): never {
  process.stderr.write(chalk.red(`Error: ${msg}\n`));
  process.exit(1);
}

function findFlow(workDir: string, demoName: string): string {
  const candidates = [
    path.join(workDir, `${demoName}.yaml`),
    path.join(workDir, 'flow.yaml'),
  ];
  const found = candidates.find(fs.existsSync);
  if (!found) die(`No flow file found in ${workDir}`);
  return found!;
}

function loadScenes(
  _workDir: string,
  _demoName: string,
  flow: ReturnType<typeof parseFlow>
): import('./types.js').SceneEntry[] {
  const inlineNarrations = extractInlineNarrations(flow);
  return extractSceneNames(flow).map((name) => ({
    scene: name,
    text: inlineNarrations.get(name),
  }));
}

function isRequired(checkName: string): boolean {
  return ['ffmpeg', 'maestro'].some((r) => checkName.toLowerCase().includes(r));
}
