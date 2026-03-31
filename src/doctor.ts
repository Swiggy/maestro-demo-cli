/**
 * doctor.ts
 *
 * Checks that all required tools and environment variables are present.
 */

import { execa } from 'execa';
import type { MaestroConfig } from './types.js';
import { maestroEnv, maestroBinPath } from './maestro-env.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export async function runDoctor(config: MaestroConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // ── ffmpeg ────────────────────────────────────────────────────────────────
  checks.push(await checkCommand('ffmpeg', ['ffmpeg', '-version'], 'Required for video compositing'));

  // ── ffprobe ───────────────────────────────────────────────────────────────
  checks.push(await checkCommand('ffprobe', ['ffprobe', '-version'], 'Required for video duration probing'));

  // ── maestro ───────────────────────────────────────────────────────────────
  {
    const bin = maestroBinPath();
    if (bin) {
      const env = await maestroEnv();
      checks.push(await checkCommand('maestro', [bin, '--version'], 'Required for mobile flow recording', env));
    } else {
      checks.push({
        name: 'maestro',
        ok: false,
        message: 'maestro not found. Install: curl -Ls "https://get.maestro.mobile.dev" | bash',
      });
    }
  }

  // ── TTS engine ────────────────────────────────────────────────────────────
  const engine = config.tts.engine;
  if (engine === 'openai') {
    checks.push(checkEnvVar('OPENAI_API_KEY', 'Required for OpenAI TTS'));
  } else if (engine === 'elevenlabs') {
    checks.push(checkEnvVar('ELEVENLABS_API_KEY', 'Required for ElevenLabs TTS'));
  } else {
    const { kokoroLikelyWorks } = await import('./tts/kokoro.js');
    const { ok, reason } = kokoroLikelyWorks();
    checks.push({
      name: 'Kokoro TTS (local)',
      ok,
      message: ok ? reason : `${reason} — switch to openai or elevenlabs engine, or upgrade Node`,
    });
  }

  // ── ADB (Android) ─────────────────────────────────────────────────────────
  if (config.video.platform === 'android') {
    checks.push(await checkCommand('adb', ['adb', 'version'], 'Android Debug Bridge (optional for device info)'));

    const devicesCheck = await checkAdbDevices();
    checks.push(devicesCheck);
  }

  // ── Xcode (iOS) ───────────────────────────────────────────────────────────
  if (config.video.platform === 'ios') {
    checks.push(await checkCommand('xcrun', ['xcrun', '--version'], 'Required for iOS simulator access'));
  }

  return checks;
}

async function checkCommand(
  name: string,
  argv: string[],
  purpose: string,
  env?: NodeJS.ProcessEnv
): Promise<DoctorCheck> {
  try {
    const r = await execa(argv[0], argv.slice(1), { stdout: 'pipe', stderr: 'pipe', env });
    const version = (r.stdout ?? r.stderr ?? '').split('\n')[0].trim();
    return { name, ok: true, message: version || purpose };
  } catch {
    return { name, ok: false, message: `${name} not found. ${purpose}` };
  }
}

function checkEnvVar(name: string, purpose: string): DoctorCheck {
  const ok = Boolean(process.env[name]);
  return {
    name,
    ok,
    message: ok ? 'Set' : `${name} is not set in environment. ${purpose}`,
  };
}

async function checkAdbDevices(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execa('adb', ['devices'], { stdout: 'pipe', stderr: 'pipe' });
    const lines = stdout.trim().split('\n').slice(1).filter((l) => l.trim() !== '');
    const connected = lines.filter((l) => !l.includes('offline')).length;
    return {
      name: 'Android device/emulator',
      ok: connected > 0,
      message: connected > 0 ? `${connected} device(s) connected` : 'No devices connected. Start an emulator or connect a device.',
    };
  } catch {
    return { name: 'Android device/emulator', ok: false, message: 'adb not available' };
  }
}

export function formatDoctorResults(checks: DoctorCheck[]): string {
  const lines = ['', '  Environment check:', '  ' + '─'.repeat(50)];

  for (const check of checks) {
    const icon = check.ok ? '✓' : '✗';
    const pad = check.name.padEnd(30);
    lines.push(`  ${icon} ${pad} ${check.message}`);
  }

  const allOk = checks.every((c) => c.ok);
  lines.push('');
  lines.push(allOk ? '  All checks passed.' : '  Some checks failed. Fix issues above before running pipeline.');
  lines.push('');

  return lines.join('\n');
}
