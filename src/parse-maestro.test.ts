import { describe, it, expect } from 'vitest';
import { parseFlow, buildAugmentedFlow, extractInlineNarrations } from './parse-maestro.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SAMPLE_FLOW = `\
appId: com.example.app
---
# @scene: launch
# @narration: Welcome to the app.
- launchApp

# @scene: login
- tapOn: "Sign In"

# @scene: home
- assertVisible: "Home"
`;

function writeTemp(content: string): string {
  const tmp = path.join(os.tmpdir(), `test-flow-${Date.now()}.yaml`);
  fs.writeFileSync(tmp, content, 'utf8');
  return tmp;
}

describe('parseFlow', () => {
  it('extracts appId', () => {
    const p = parseFlow(writeTemp(SAMPLE_FLOW));
    expect(p.appId).toBe('com.example.app');
  });

  it('finds all @scene markers', () => {
    const p = parseFlow(writeTemp(SAMPLE_FLOW));
    expect(p.scenes.map((s) => s.name)).toEqual(['launch', 'login', 'home']);
  });

  it('resolves stepLineIndex past blank/comment lines', () => {
    const p = parseFlow(writeTemp(SAMPLE_FLOW));
    // launch scene: comment at some line, next step is "- launchApp"
    const launch = p.scenes[0];
    expect(p.lines[launch.stepLineIndex]).toMatch(/launchApp/);
  });
});

describe('extractInlineNarrations', () => {
  it('picks up @narration comments', () => {
    const p = parseFlow(writeTemp(SAMPLE_FLOW));
    const narrations = extractInlineNarrations(p);
    expect(narrations.get('launch')).toBe('Welcome to the app.');
    expect(narrations.get('login')).toBeUndefined();
  });
});

describe('buildAugmentedFlow', () => {
  it('injects sleep after each step', () => {
    const p = parseFlow(writeTemp(SAMPLE_FLOW));
    const durations = new Map([
      ['launch', 2000],
      ['login', 1500],
      ['home', 1000],
    ]);
    const augmented = buildAugmentedFlow(p, durations);
    expect(augmented).toContain('- sleep: 2000');
    expect(augmented).toContain('- sleep: 1500');
    expect(augmented).toContain('- sleep: 1000');
  });

  it('preserves original steps', () => {
    const p = parseFlow(writeTemp(SAMPLE_FLOW));
    const durations = new Map([['launch', 2000]]);
    const augmented = buildAugmentedFlow(p, durations);
    expect(augmented).toContain('- launchApp');
    expect(augmented).toContain('- tapOn: "Sign In"');
  });

  it('skips scenes with 0 duration', () => {
    const p = parseFlow(writeTemp(SAMPLE_FLOW));
    const durations = new Map<string, number>();
    const augmented = buildAugmentedFlow(p, durations);
    expect(augmented).not.toContain('- sleep:');
  });
});
