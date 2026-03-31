# maestro-demo-cli

Turn [Maestro](https://maestro.mobile.dev) mobile test flows into polished product demo videos with AI voiceover.

Inspired by [argo](https://github.com/shreyaskarnik/argo) — but for mobile apps.

```
maestro-demo pipeline my-demo
```

## How it works

1. **Annotate** your Maestro YAML flow with `# @scene:` markers
3. **Run** `maestro-demo pipeline <demo>`
4. The tool generates TTS audio, injects timing waits into the flow, records with Maestro, and composites the final video with FFmpeg

## Prerequisites

### Node.js ≥ 20

Node 20 is required. The Kokoro (local TTS) engine uses a phonemizer WASM module that crashes on Node 18.

```bash
# Using nvm
nvm install 20
nvm use 20
```

### Maestro CLI

Install via the official script — **do not use `brew install maestro`** (that installs a different unrelated app):

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
```

Verify:
```bash
~/.maestro/bin/maestro --version
```

### Java 17+

Maestro requires a JDK. Install via Homebrew:

```bash
brew install openjdk@17
```

If you have a broken or missing `JAVA_HOME`, `maestro-demo doctor` will tell you. The tool automatically resolves `JAVA_HOME` from common install locations, including the Homebrew path above.

### FFmpeg

```bash
brew install ffmpeg
```

### Android emulator or iOS simulator

Have an emulator/simulator running before invoking the pipeline. On Android you can use Android Studio's AVD Manager or:

```bash
# List available AVDs
emulator -list-avds

# Launch one
emulator -avd <avd-name>
```

## Installation

```bash
yarn add -g @swiggy/maestro-demo-cli
# or run directly without installing
npx @swiggy/maestro-demo-cli pipeline my-demo
```

## Quick start

```bash
# Check your environment first
maestro-demo doctor

# Scaffold a new project
maestro-demo init

# Or convert an existing flow
maestro-demo init --from tests/login.yaml --demo login-demo

# Run the full pipeline
maestro-demo pipeline login-demo
```

## Flow annotation

Add `# @scene:` markers to your Maestro YAML before each step you want to narrate. Optionally include `# @narration:` on the next line:

```yaml
appId: com.example.app
---
# @scene: launch
# @narration: Welcome to the app. Let's sign in.
- launchApp

# @scene: enter-email
# @narration: Enter your email address.
- tapOn: "Email"
- inputText: "demo@example.com"

# @scene: submit
# @narration: Tap Sign In to continue.
- tapOn: "Sign In"

# @scene: home
# @narration: You're now on the home screen.
- assertVisible: "Home"
```

Rules:
- `# @scene:` must appear directly before the step it labels
- `# @narration:` must appear on the line immediately after `# @scene:`
- Scene names must be unique within a flow
- Multi-line steps (e.g. `- tapOn:\n    id: foo`) are handled correctly — waits are injected between scenes, not inside steps

## Configuration

`maestro-demo.config.json` (place in your project root):

```json
{
  "demosDir": "demos",
  "outputDir": "videos",
  "tts": {
    "engine": "kokoro",
    "defaultVoice": "af_heart",
    "defaultSpeed": 1.0
  },
  "video": {
    "width": 390,
    "height": 844,
    "fps": 30,
    "platform": "android"
  },
  "export": {
    "preset": "slow",
    "crf": 18,
    "formats": ["mp4"],
    "audio": { "loudnorm": false },
    "watermark": {
      "src": "assets/logo.png",
      "position": "bottom-right",
      "opacity": 0.7
    }
  }
}
```

## TTS engines

| Engine       | Setup                               | Notes                                  |
|--------------|--------------------------------------|----------------------------------------|
| `kokoro`     | None — runs fully locally            | Default. Requires Node ≥ 20. First run downloads ~300 MB model. |
| `openai`     | Set `OPENAI_API_KEY`                 | Uses `tts-1` model                     |
| `elevenlabs` | Set `ELEVENLABS_API_KEY`             |                                        |
| `sarvam`     | Set `SARVAM_API_KEY`                 | Indian-language voices via Bulbul model. Great for Hindi, Tamil, Telugu, and other Indic languages as well as Indian-accented English. |

Kokoro runs in a worker thread to avoid WASM mutex issues on macOS ARM (Apple Silicon). The model is cached after the first download.

### Using Sarvam AI

Sarvam AI's [Bulbul](https://docs.sarvam.ai) model supports 11 Indian languages and 30+ voices. Set your API key, then point the engine at `sarvam` in your config:

```bash
export SARVAM_API_KEY=your_key_here
```

```json
{
  "tts": {
    "engine": "sarvam",
    "defaultVoice": "shubh",
    "defaultSpeed": 1.0,
    "sarvamModel": "bulbul:v3",
    "sarvamLanguageCode": "en-IN"
  }
}
```

**Available voices (Bulbul v3)**

| Gender | Voices |
|--------|--------|
| Male   | `shubh`, `aditya`, `rahul`, `rohan`, `amit`, `dev`, `ratan`, `varun`, `manan`, `kabir`, `arjun` |
| Female | `ritu`, `priya`, `neha`, `pooja`, `simran`, `kavya`, `ishita`, `shreya`, `roopa`, `amelia`, `sophia` |

**Supported language codes**

| Language   | Code    |
|------------|---------|
| English (Indian) | `en-IN` |
| Hindi      | `hi-IN` |
| Bengali    | `bn-IN` |
| Tamil      | `ta-IN` |
| Telugu     | `te-IN` |
| Kannada    | `kn-IN` |
| Malayalam  | `ml-IN` |
| Marathi    | `mr-IN` |
| Gujarati   | `gu-IN` |
| Punjabi    | `pa-IN` |
| Odia       | `or-IN` |

For multilingual demos, override the language per-scene in your manifest:

```json
[
  { "scene": "launch",  "text": "Welcome to the app.", "voice": "shubh" },
  { "scene": "login",   "text": "ऐप में आपका स्वागत है।", "voice": "ritu" }
]
```

`pace` maps to the standard `defaultSpeed` field (range `0.5`–`2.0`).

## Cropping to the app screen

`maestro record --local` captures the full emulator window, which includes the Maestro terminal log on the left and the device chrome around the phone. Run `detect-crop` after your first recording to automatically find the app screen bounds and save them to config:

```bash
maestro-demo detect-crop login-demo --preview
```

This extracts a frame from the raw recording, detects the bright rectangular app screen region via pixel brightness analysis, opens a preview PNG so you can verify, and writes the result to `maestro-demo.config.json`:

```json
"video": {
  "width": 390,
  "height": 844,
  "fps": 30,
  "platform": "android",
  "crop": {
    "x": 1431,
    "y": 41,
    "width": 447,
    "height": 997
  }
}
```

Then re-export:

```bash
maestro-demo export login-demo
```

**Crop coordinates are specific to your emulator and window layout.** Re-run `detect-crop` if you switch emulators or change the window size. You can also set the coordinates manually by opening `demos/<name>/.maestro-demo/raw.mp4` in a video player and hovering to read pixel coordinates.

## Commands

```
maestro-demo pipeline <demo>        Full pipeline: TTS → record → export
maestro-demo tts <demo>             Generate TTS audio clips only
maestro-demo record <demo>          Record the Maestro flow only
maestro-demo export <demo>          Re-export video from a cached recording
maestro-demo detect-crop <demo>     Auto-detect app screen crop from raw recording
maestro-demo detect-crop --preview  Same, and open a preview frame to verify
maestro-demo validate <demo>        Validate flow annotation and manifest
maestro-demo doctor                 Check Node version, Maestro, Java, FFmpeg, and emulator
maestro-demo init                   Scaffold a new project
maestro-demo init --from <f>        Convert an existing Maestro flow
```

The pipeline caches TTS clips and the raw recording under `demos/<name>/.maestro-demo/`. Use `maestro-demo export <demo>` to re-composite without re-recording.

## Project structure

```
my-project/
├── maestro-demo.config.json
├── demos/
│   └── login-demo/
│       ├── login-demo.yaml              # Maestro flow with @scene markers
│       └── .maestro-demo/              # Cache (gitignore this)
│           ├── augmented-flow.yaml      # Flow with injected waits (generated)
│           ├── raw.mp4                  # Raw Maestro recording (generated)
│           └── tts/                     # Cached TTS audio clips
└── videos/
    └── login-demo.mp4                   # Final output
```

Add `.maestro-demo/` to your `.gitignore`.

## How timing works

`maestro-demo` injects `waitForAnimationToEnd` commands into a temporary copy of your flow based on each scene's TTS audio duration. This makes timing deterministic — the device holds the current state while narration plays, then continues to the next step.

The wait is inserted **between scenes** (just before the next `# @scene:` marker), not after individual steps. This correctly handles multi-line Maestro steps like `tapOn` with sub-keys.

```
Original flow:              Augmented flow (sent to Maestro):
──────────────────          ──────────────────────────────────────
# @scene: launch            # @scene: launch
- launchApp            →    - launchApp
                            - waitForAnimationToEnd:
                                timeout: 3200              ← TTS duration in ms
# @scene: login             # @scene: login
- tapOn:               →    - tapOn:
    id: email_input             id: email_input
                            - waitForAnimationToEnd:
                                timeout: 2800
```

Scene start times in the final video are computed from cumulative TTS durations — no device-side instrumentation needed.

## Troubleshooting

**`Unable to launch app <appId>`** — The app isn't installed on the connected emulator/simulator. Check your `appId` and make sure the app is installed.

**`maestro: command not found`** — Maestro installs to `~/.maestro/bin` which isn't in your default `PATH`. `maestro-demo` adds it automatically when invoking Maestro. To use `maestro` directly in your shell, add `export PATH="$HOME/.maestro/bin:$PATH"` to your shell profile.

**`JAVA_HOME is set to an invalid directory`** — Run `maestro-demo doctor` to diagnose. Install Java with `brew install openjdk@17`.

**Kokoro crashes or hangs** — Ensure you're on Node ≥ 20 (`node --version`). On first run, the model download (~300 MB) may take a minute.

**`maestro record` fails with ngrok/network error** — The legacy cloud renderer is deprecated. This tool uses `--local` rendering automatically, which doesn't require a network connection.

## Inspiration

This project is based on [argo](https://github.com/shreyaskarnik/argo) by [@shreyaskarnik](https://github.com/shreyaskarnik), which does the same thing for web apps using Playwright. `maestro-demo` adapts the concept for mobile — replacing Playwright with Maestro YAML flows and adding mobile-specific handling for TTS timing, YAML flow augmentation, and Maestro's recording pipeline.

## License

MIT
