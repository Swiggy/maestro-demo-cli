/**
 * validate.ts
 *
 * Validates a demo's flow YAML and scenes manifest before execution.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseFlow, readScenesManifest, extractSceneNames, extractInlineNarrations } from './parse-maestro.js';
import { demoWorkDir } from './config.js';
import type { MaestroConfig } from './types.js';

export interface ValidationResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

export function validateDemo(
  demoName: string,
  config: MaestroConfig,
  projectRoot = process.cwd()
): ValidationResult {
  const workDir = demoWorkDir(demoName, config, projectRoot);
  const warnings: string[] = [];
  const errors: string[] = [];

  // ── Check work dir ────────────────────────────────────────────────────────
  if (!fs.existsSync(workDir)) {
    errors.push(`Demo directory not found: ${workDir}`);
    return { ok: false, warnings, errors };
  }

  // ── Find flow file ────────────────────────────────────────────────────────
  const flowPath = [
    path.join(workDir, `${demoName}.yaml`),
    path.join(workDir, 'flow.yaml'),
  ].find(fs.existsSync);

  if (!flowPath) {
    errors.push(`No flow file found. Create ${workDir}/${demoName}.yaml`);
    return { ok: false, warnings, errors };
  }

  // ── Parse YAML ────────────────────────────────────────────────────────────
  // Maestro flows are multi-document YAML (separated by ---), so we use our
  // regex-based parser rather than yaml.load() which only handles single docs.
  let flow: ReturnType<typeof parseFlow>;
  try {
    flow = parseFlow(flowPath);
  } catch (err: unknown) {
    errors.push(`Could not parse flow file ${flowPath}: ${(err as Error).message}`);
    return { ok: false, warnings, errors };
  }

  if (!flow.appId) {
    warnings.push(`No appId found in flow. Make sure your YAML has "appId: com.example.app"`);
  }

  // ── Scene markers ─────────────────────────────────────────────────────────
  const sceneNames = extractSceneNames(flow);
  if (sceneNames.length === 0) {
    warnings.push(
      `No @scene markers found in ${flowPath}. ` +
      `Add "# @scene: <name>" comments before steps to define scenes.`
    );
  }

  // Check for duplicate scene names
  const seen = new Set<string>();
  for (const name of sceneNames) {
    if (seen.has(name)) {
      errors.push(`Duplicate scene name: "${name}"`);
    }
    seen.add(name);
  }

  // ── Scenes manifest ───────────────────────────────────────────────────────
  const manifestPath = path.join(workDir, `${demoName}.scenes.json`);
  if (fs.existsSync(manifestPath)) {
    try {
      const entries = readScenesManifest(manifestPath);
      const manifestNames = new Set(entries.map((e) => e.scene));

      // Warn about scenes in manifest that aren't in flow
      for (const name of manifestNames) {
        if (!seen.has(name)) {
          warnings.push(`Scene "${name}" in manifest but not found as @scene marker in flow`);
        }
      }

      // Warn about flow scenes missing from manifest
      for (const name of sceneNames) {
        if (!manifestNames.has(name)) {
          warnings.push(`Scene "${name}" in flow but missing from manifest (will be silent)`);
        }
      }

      // Warn about entries with no text
      for (const entry of entries) {
        if (!entry.silent && !entry.text?.trim()) {
          warnings.push(`Scene "${entry.scene}" has no text and is not marked silent`);
        }
      }
    } catch (err: unknown) {
      errors.push(`Invalid scenes manifest: ${(err as Error).message}`);
    }
  } else {
    // Check for inline narrations
    const inlineNarrations = extractInlineNarrations(flow);
    const missingNarration = sceneNames.filter((n) => !inlineNarrations.has(n));
    if (missingNarration.length > 0) {
      warnings.push(
        `No narration text for scenes: ${missingNarration.join(', ')}. ` +
        `Create ${demoName}.scenes.json or add "# @narration: <text>" comments.`
      );
    }
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
  };
}
