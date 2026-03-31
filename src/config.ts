import fs from 'node:fs';
import path from 'node:path';
import type { MaestroConfig } from './types.js';

const DEFAULTS: MaestroConfig = {
  demosDir: 'demos',
  outputDir: 'videos',
  tts: {
    engine: 'kokoro',
    defaultVoice: 'af_heart',
    defaultSpeed: 1.0,
  },
  video: {
    width: 390,
    height: 844,
    fps: 30,
    platform: 'android',
    deviceScaleFactor: 1,
  },
  export: {
    preset: 'slow',
    crf: 18,
    tailPadMs: 800,
    formats: ['mp4'],
    sharpen: true,
    audio: {
      loudnorm: false,
    },
  },
};

export function loadConfig(configPath?: string, projectRoot = process.cwd()): MaestroConfig {
  const candidates = configPath
    ? [configPath]
    : [
        path.join(projectRoot, 'maestro-demo.config.json'),
        path.join(projectRoot, 'maestro-demo.json'),
        path.join(projectRoot, '.maestro-demo.json'),
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Partial<MaestroConfig>;
      return deepMerge(DEFAULTS as unknown as Record<string, unknown>, raw as Record<string, unknown>) as unknown as MaestroConfig;
    }
  }

  return DEFAULTS;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && typeof base[key] === 'object') {
      result[key] = deepMerge(base[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export function demosDir(config: MaestroConfig, projectRoot = process.cwd()): string {
  return path.resolve(projectRoot, config.demosDir);
}

export function outputDir(config: MaestroConfig, projectRoot = process.cwd()): string {
  return path.resolve(projectRoot, config.outputDir);
}

export function demoWorkDir(demoName: string, config: MaestroConfig, projectRoot = process.cwd()): string {
  return path.join(demosDir(config, projectRoot), demoName);
}
