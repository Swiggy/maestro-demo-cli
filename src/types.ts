// ─── TTS ───────────────────────────────────────────────────────────────────

export type TTSEngineType = 'kokoro' | 'openai' | 'elevenlabs' | 'sarvam';

export interface TTSConfig {
  engine: TTSEngineType;
  defaultVoice: string;
  defaultSpeed: number;
  /** OpenAI-specific */
  openaiModel?: string;
  /** ElevenLabs-specific */
  elevenLabsModel?: string;
  /** Sarvam-specific */
  sarvamModel?: string;
  /** Sarvam target language code for TTS. Default: 'en-IN' */
  sarvamLanguageCode?: string;
  /** Whether to translate text before TTS using Sarvam's translate API. Default: false. */
  sarvamTranslate?: boolean;
  /** Sarvam source language code for translation. Default: 'en-IN' */
  sarvamSourceLanguageCode?: string;
}

// ─── Video ─────────────────────────────────────────────────────────────────

export type Platform = 'android' | 'ios';

export interface CropConfig {
  /** X offset into the raw recording (px) */
  x: number;
  /** Y offset into the raw recording (px) */
  y: number;
  /** Width to crop from the raw recording (px) */
  width: number;
  /** Height to crop from the raw recording (px) */
  height: number;
}

export interface VideoConfig {
  /** Target output width (px). Default: 390 (iPhone 14 logical) */
  width: number;
  /** Target output height (px). Default: 844 */
  height: number;
  fps: number;
  platform: Platform;
  /** Logical scale factor of device screen. Default: 1 */
  deviceScaleFactor?: number;
  /**
   * Crop region to extract from the raw Maestro recording before scaling.
   * Use this to cut out the Maestro terminal log and device chrome so only
   * the app screen appears. Find coordinates by inspecting raw.mp4 with
   * a video player or running: ffmpeg -i raw.mp4 -vframes 1 frame.png
   */
  crop?: CropConfig;
}

// ─── Export ────────────────────────────────────────────────────────────────

export type TransitionType = 'fade-through-black' | 'dissolve' | 'none';

export interface TransitionConfig {
  type: TransitionType;
  durationMs?: number;
}

export interface SpeedRampConfig {
  /** Playback multiplier for gaps between scenes. Default: 2.0 */
  gapSpeed: number;
  /** Minimum gap duration to ramp. Default: 500ms */
  minGapMs?: number;
}

export interface AudioConfig {
  loudnorm?: boolean;
  music?: string;
  musicVolume?: number;
}

export interface WatermarkConfig {
  src: string;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  opacity?: number;
  margin?: number;
}

export interface ExportConfig {
  preset: string;
  crf: number;
  formats?: Array<'mp4' | 'gif' | '9:16'>;
  transition?: TransitionConfig;
  speedRamp?: SpeedRampConfig;
  audio?: AudioConfig;
  watermark?: WatermarkConfig;
  sharpen?: boolean | { strength: number };
  /** Extra padding at end of video (ms). Default: 800 */
  tailPadMs?: number;
}

// ─── Master config ─────────────────────────────────────────────────────────

export interface MaestroConfig {
  /** Directory containing demo subfolders. Default: 'demos' */
  demosDir: string;
  /** Directory to write final videos. Default: 'videos' */
  outputDir: string;
  tts: TTSConfig;
  video: VideoConfig;
  export: ExportConfig;
}

// ─── Scene manifest ────────────────────────────────────────────────────────

export interface SceneEntry {
  /** Matches the @scene marker name in the YAML flow */
  scene: string;
  /** Narration text for TTS */
  text?: string;
  /** Per-scene voice override */
  voice?: string;
  /** Per-scene speed override */
  speed?: number;
  /** Skip TTS generation (silent scene) */
  silent?: boolean;
}

// ─── Recording ─────────────────────────────────────────────────────────────

export interface SceneTiming {
  scene: string;
  startMs: number;
  endMs: number;
}

export interface RecordResult {
  videoPath: string;
  timings: SceneTiming[];
}

// ─── Timeline ──────────────────────────────────────────────────────────────

export interface AudioPlacement {
  scene: string;
  audioPath: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface SilentPlacement {
  scene: string;
  audioPath?: never;
  startMs: number;
  endMs: number;
}

export type Placement = AudioPlacement | SilentPlacement;
