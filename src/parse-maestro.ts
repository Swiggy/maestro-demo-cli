/**
 * parse-maestro.ts
 *
 * Parses Maestro YAML flow files and extracts:
 *   1. Scene markers: lines with "# @scene: <name>" comments
 *   2. The appId from the flow header
 *   3. The ordered list of steps (for augmenting with waits)
 *
 * Scene markers must appear directly before the step they label, e.g.:
 *
 *   # @scene: login-screen
 *   - tapOn: "Sign In"
 *
 * The scene is considered active from that step until the next @scene marker.
 */

import fs from 'node:fs';

export interface ParsedFlow {
  appId: string;
  /** Raw YAML lines (for augmentation) */
  lines: string[];
  /** Scene marker positions: scene name → line index of the YAML step that follows */
  scenes: SceneMarker[];
}

export interface SceneMarker {
  name: string;
  /** Line index (0-based) of the "# @scene:" comment */
  commentLineIndex: number;
  /** Line index of the next actual step after the comment */
  stepLineIndex: number;
}

const SCENE_RE = /^\s*#\s*@scene:\s*(.+?)\s*$/;

export function parseFlow(flowPath: string): ParsedFlow {
  const raw = fs.readFileSync(flowPath, 'utf8');
  const lines = raw.split('\n');

  // Extract appId from YAML header. Maestro flows use a multi-document
  // YAML format (separated by ---), so we use a regex for reliability.
  let appId = '';
  const appIdMatch = /^appId:\s*(.+?)\s*$/m.exec(raw);
  if (appIdMatch) {
    appId = appIdMatch[1];
  }

  const scenes: SceneMarker[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = SCENE_RE.exec(lines[i]);
    if (!match) continue;

    const name = match[1];
    // Find the next non-empty, non-comment line (the actual step)
    let stepLineIndex = i + 1;
    while (stepLineIndex < lines.length) {
      const trimmed = lines[stepLineIndex].trim();
      if (trimmed !== '' && !trimmed.startsWith('#')) break;
      stepLineIndex++;
    }

    scenes.push({ name, commentLineIndex: i, stepLineIndex });
  }

  return { appId, lines, scenes };
}

/**
 * Returns the ordered list of scene names as they appear in the flow.
 */
export function extractSceneNames(flow: ParsedFlow): string[] {
  return flow.scenes.map((s) => s.name);
}

/**
 * Builds an augmented copy of the flow YAML with `waitForAnimationToEnd`
 * commands injected between scenes. The wait gives time for the TTS narration
 * to play while the device holds on the current state.
 *
 * Insertion strategy: we insert the wait BEFORE the next scene's @scene comment
 * (or at the end of file for the last scene). This avoids the multi-line YAML
 * problem that occurs when a step spans multiple lines (e.g. `- tapOn:\n    id:`).
 *
 * @param flow       Parsed flow
 * @param durations  Map of scene name → TTS duration in ms
 */
export function buildAugmentedFlow(flow: ParsedFlow, durations: Map<string, number>): string {
  const lines = [...flow.lines];

  // Build insertion points: for scene[i], insert just before scene[i+1]'s comment line,
  // or append at end of file for the last scene.
  // Process in reverse so splices don't shift earlier indices.
  for (let i = flow.scenes.length - 1; i >= 0; i--) {
    const scene = flow.scenes[i];
    const durationMs = durations.get(scene.name) ?? 0;
    if (durationMs <= 0) continue;

    const nextScene = flow.scenes[i + 1];
    // Insert just before the next @scene comment, or at end of non-empty content
    const insertBefore = nextScene
      ? nextScene.commentLineIndex
      : findLastContentLine(lines) + 1;

    const indent = detectIndent(lines[scene.stepLineIndex]);
    const waitLine = `${indent}- waitForAnimationToEnd:\n${indent}    timeout: ${durationMs}`;

    lines.splice(insertBefore, 0, waitLine);
  }

  return lines.join('\n');
}

function findLastContentLine(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') return i;
  }
  return lines.length - 1;
}

function detectIndent(line: string): string {
  const match = /^(\s*)/.exec(line);
  return match ? match[1] : '';
}

/**
 * Reads the scenes manifest JSON from `<demoDir>/<demoName>.scenes.json`.
 * Falls back to reading inline narration comments from the YAML flow.
 */
export function readScenesManifest(manifestPath: string): import('./types.js').SceneEntry[] {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const entries = JSON.parse(raw) as import('./types.js').SceneEntry[];
  if (!Array.isArray(entries)) throw new Error(`${manifestPath} must be a JSON array`);
  for (const e of entries) {
    if (typeof e.scene !== 'string') throw new Error(`Each scene entry must have a "scene" string`);
  }
  return entries;
}

/**
 * Extracts inline narration text from `# @narration:` comments that appear
 * on the line directly after a `# @scene:` comment. Useful when the user
 * wants to keep everything in the YAML file.
 *
 * Example:
 *   # @scene: welcome
 *   # @narration: Welcome to the app. Let's get started.
 *   - launchApp
 */
export function extractInlineNarrations(flow: ParsedFlow): Map<string, string> {
  const NARRATION_RE = /^\s*#\s*@narration:\s*(.+?)\s*$/;
  const result = new Map<string, string>();

  for (const scene of flow.scenes) {
    // Check lines immediately following the @scene comment
    for (let i = scene.commentLineIndex + 1; i < scene.stepLineIndex; i++) {
      const match = NARRATION_RE.exec(flow.lines[i]);
      if (match) {
        result.set(scene.name, match[1]);
        break;
      }
    }
  }

  return result;
}
