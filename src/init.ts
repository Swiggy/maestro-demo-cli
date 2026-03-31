/**
 * init.ts
 *
 * Scaffolds a new maestro-demo project or converts an existing Maestro flow.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseFlow, extractSceneNames, extractInlineNarrations } from './parse-maestro.js';

export interface InitOptions {
  /** Import an existing Maestro flow file */
  from?: string;
  /** Demo name (defaults to inferred from --from filename or 'my-demo') */
  name?: string;
  projectRoot?: string;
}

export function initProject(options: InitOptions = {}): void {
  const projectRoot = options.projectRoot ?? process.cwd();
  const demoName = options.name ?? (options.from ? path.basename(options.from, path.extname(options.from)) : 'my-demo');
  const demoDir = path.join(projectRoot, 'demos', demoName);

  fs.mkdirSync(demoDir, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'videos'), { recursive: true });

  // ── Config file ───────────────────────────────────────────────────────────
  const configPath = path.join(projectRoot, 'maestro-demo.config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          demosDir: 'demos',
          outputDir: 'videos',
          tts: { engine: 'kokoro', defaultVoice: 'af_heart', defaultSpeed: 1.0 },
          video: { width: 390, height: 844, fps: 30, platform: 'android' },
          export: { preset: 'slow', crf: 18, audio: { loudnorm: true } },
        },
        null,
        2
      ),
      'utf8'
    );
    process.stdout.write(`  created maestro-demo.config.json\n`);
  }

  // ── Flow file ─────────────────────────────────────────────────────────────
  const flowDest = path.join(demoDir, `${demoName}.yaml`);

  if (options.from) {
    // Convert existing flow: inject scene markers before each step
    const converted = convertExistingFlow(options.from, demoName);
    fs.writeFileSync(flowDest, converted, 'utf8');
    process.stdout.write(`  converted ${options.from} → ${flowDest}\n`);

    // Auto-generate scenes manifest from converted flow
    const flow = parseFlow(flowDest);
    const sceneNames = extractSceneNames(flow);
    const inlineNarrations = extractInlineNarrations(flow);
    if (sceneNames.length > 0) {
      const manifest = sceneNames.map((name) => ({
        scene: name,
        text: inlineNarrations.get(name) ?? `Describe what happens in "${name}" here.`,
      }));
      const manifestPath = path.join(demoDir, `${demoName}.scenes.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      process.stdout.write(`  created ${manifestPath}\n`);
    }
  } else {
    // Write a starter template
    if (!fs.existsSync(flowDest)) {
      fs.writeFileSync(flowDest, STARTER_FLOW_TEMPLATE(demoName), 'utf8');
      process.stdout.write(`  created ${flowDest}\n`);
    }

    // Starter scenes manifest
    const manifestPath = path.join(demoDir, `${demoName}.scenes.json`);
    if (!fs.existsSync(manifestPath)) {
      fs.writeFileSync(manifestPath, STARTER_SCENES_MANIFEST, 'utf8');
      process.stdout.write(`  created ${manifestPath}\n`);
    }
  }

  process.stdout.write(`\nNext steps:\n`);
  process.stdout.write(`  1. Edit demos/${demoName}/${demoName}.yaml — add @scene markers\n`);
  process.stdout.write(`  2. Edit demos/${demoName}/${demoName}.scenes.json — add narration text\n`);
  process.stdout.write(`  3. Run: maestro-demo pipeline ${demoName}\n\n`);
}

/**
 * Converts an existing Maestro flow by inserting @scene markers before
 * action steps. Scene names are auto-derived from step content.
 */
function convertExistingFlow(flowPath: string, demoName: string): string {
  const raw = fs.readFileSync(flowPath, 'utf8');
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch {
    throw new Error(`Could not parse ${flowPath} as YAML`);
  }

  if (!Array.isArray(doc) && typeof doc !== 'object') {
    throw new Error(`Unexpected YAML structure in ${flowPath}`);
  }

  // Re-stringify line by line, inserting scene comments
  const lines = raw.split('\n');
  const result: string[] = [];
  let sceneIdx = 0;
  const stepRe = /^(\s*)-\s+(\w+):/;

  for (const line of lines) {
    const match = stepRe.exec(line);
    if (match) {
      const stepName = match[2];
      // Skip metadata-like steps
      if (!['appId', 'name', 'tags', 'onFlowStart', 'onFlowComplete'].includes(stepName)) {
        const sceneName = `${demoName}-scene-${++sceneIdx}`;
        result.push(`${match[1]}# @scene: ${sceneName}`);
      }
    }
    result.push(line);
  }

  return result.join('\n');
}

const STARTER_FLOW_TEMPLATE = (name: string) => `\
appId: com.example.app
---
# @scene: launch
# @narration: Let's open the app and get started.
- launchApp

# @scene: main-screen
# @narration: Here's the main screen. Tap "Get Started" to continue.
- tapOn: "Get Started"

# @scene: next-step
# @narration: Great! You can see the next step here.
- assertVisible: "Welcome"
`;

const STARTER_SCENES_MANIFEST = JSON.stringify(
  [
    { scene: 'launch', text: "Let's open the app and get started." },
    { scene: 'main-screen', text: 'Here\'s the main screen. Tap "Get Started" to continue.' },
    { scene: 'next-step', text: 'Great! You can see the next step here.' },
  ],
  null,
  2
) + '\n';
