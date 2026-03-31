/**
 * maestro-env.ts
 *
 * Resolves the PATH and JAVA_HOME needed to run the Maestro CLI.
 * Maestro installs to ~/.maestro/bin which is not in the default PATH
 * when launched from a non-interactive shell (e.g. via execa).
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

const MAESTRO_BIN = path.join(os.homedir(), '.maestro', 'bin');

/**
 * Returns a merged env object with ~/.maestro/bin prepended to PATH and
 * JAVA_HOME resolved to the first usable JVM found on the system.
 */
export async function maestroEnv(): Promise<NodeJS.ProcessEnv> {
  const javaHome = await resolveJavaHome();
  const javaBin = javaHome ? path.join(javaHome, 'bin') : null;
  const extraPath = [MAESTRO_BIN, javaBin, process.env.PATH].filter(Boolean).join(':');

  return {
    ...process.env,
    PATH: extraPath,
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
  };
}

/**
 * Returns the path to an installed JVM, preferring:
 *   1. A valid existing JAVA_HOME
 *   2. /usr/libexec/java_home (macOS)
 *   3. Common Homebrew/sdkman locations
 */
async function resolveJavaHome(): Promise<string | null> {
  // If JAVA_HOME is already set and valid, use it
  const current = process.env.JAVA_HOME;
  if (current && fs.existsSync(path.join(current, 'bin', 'java'))) {
    return current;
  }

  // macOS system helper
  try {
    const { stdout } = await execa('/usr/libexec/java_home', ['-v', '17+'], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const p = stdout.trim();
    if (p && fs.existsSync(path.join(p, 'bin', 'java'))) return p;
  } catch { /* not available */ }

  // Fallback: scan known JVM install locations
  const candidates = [
    '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
    '/Library/Java/JavaVirtualMachines',
    path.join(os.homedir(), 'Library/Java/JavaVirtualMachines'),
  ];

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    if (fs.existsSync(path.join(dir, 'bin', 'java'))) return dir;
    // Directory of JVM bundles — find the newest one
    const jvms = fs.readdirSync(dir)
      .map(d => path.join(dir, d, 'Contents', 'Home'))
      .filter(p => fs.existsSync(path.join(p, 'bin', 'java')))
      .sort()
      .reverse();
    if (jvms.length > 0) return jvms[0];
  }

  return null;
}

/**
 * Returns the full path to the maestro binary, or null if not found.
 */
export function maestroBinPath(): string | null {
  const candidate = path.join(MAESTRO_BIN, 'maestro');
  if (fs.existsSync(candidate)) return candidate;
  return null;
}
