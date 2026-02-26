# Common Pitfalls and Fixes

Use this map to avoid repeating the same failures.

## 1) Wrong working directory (publishing/checking the wrong package)

- Symptom:
  - `npm publish` mentions `openclaw@...` instead of `serial-adapter@...`
  - Build runs `pnpm build && pnpm ui:build` unexpectedly.
- Root cause:
  - Command executed in OpenClaw core folder, not plugin repo root.
- Fix:
  - `cd C:\Users\DD\openclaw-plugin-test\openclaw-serial-adapter-ts-blocks`
  - `npm pack --dry-run`
  - Confirm output shows `serial-adapter@<version>`.
- Prevention:
  - Always run `npm run preflight-runtime` before publish.

## 2) OpenClaw OAuth refresh failures (`refresh_token_reused`, auth expired)

- Symptom:
  - Telegram/OpenClaw reply: `Agent failed before reply: OAuth token refresh failed ...`
- Root cause:
  - OAuth profile expired/reused and not re-authenticated.
- Fix:
  - `openclaw models auth login --provider openai-codex --set-default`
  - `openclaw models status --json`
  - Ensure provider status is `ok`.
- Prevention:
  - Use `npm run preflight-runtime` and watch auth warnings before sessions.

## 3) npm auth failures (`ENEEDAUTH`, `E401`, OTP timeout)

- Symptom:
  - `npm whoami` fails
  - `npm publish` fails with auth/otp errors.
- Root cause:
  - Missing/expired token, wrong login method, or OTP timed out.
- Fix:
  - `npm whoami` must return username first.
  - Re-auth via supported account flow.
  - Run publish with fresh OTP immediately:
    - `npm publish --access public --otp=<code>`
- Prevention:
  - Do not delay between reading OTP and running publish.

## 4) Config schema drift (invalid keys)

- Symptom:
  - `Invalid config ... Unrecognized key ...`
- Root cause:
  - Old keys remain in `~/.openclaw/openclaw.json`.
- Fix:
  - `openclaw doctor --fix`
  - Recheck with `openclaw gateway status --json`.
- Prevention:
  - Run preflight gate after any OpenClaw version change.

## 5) Plugin uninstall/install collisions (`plugin already exists`, `EBUSY`)

- Symptom:
  - Install says plugin exists.
  - Uninstall fails due to lock/busy files.
- Root cause:
  - Gateway/runtime still holding plugin files.
- Fix:
  - `openclaw gateway stop`
  - remove plugin folder under `~/.openclaw/extensions/serial-adapter`
  - `openclaw gateway start`
  - `openclaw plugins install serial-adapter`
- Prevention:
  - Stop gateway before uninstall/reinstall cycles.

## 6) COM contention (upload vs runtime)

- Symptom:
  - Upload fails or serial bridge cannot connect.
- Root cause:
  - Arduino IDE Serial Monitor/uploader and runtime share same COM.
- Fix:
  - Pause runtime before upload:
    - `python examples/runtime_ops.py pause --hold-s 30`
  - Upload firmware.
  - Resume runtime:
    - `python examples/runtime_ops.py resume`
- Prevention:
  - Treat upload/runtime as two phases; do not use same COM concurrently.

## 7) `serial_silent_no_telemetry_bytes` (connected but no IMU stream)

- Symptom:
  - `self-verify` / `hardware_e2e_check` diagnosis is `serial_silent_no_telemetry_bytes`
  - `telemetry_frames=0`, `has_ax_ay_az=false`.
- Root cause:
  - Running silent/autonomous firmware or wrong baud/protocol.
- Fix:
  - Flash telemetry-capable firmware (outputs `ax/ay/az` at 115200).
  - Confirm telemetry with:
    - `python scripts/hardware_e2e_check.py --host 127.0.0.1 --control-port 9001 --telemetry-port 9000 --observe-s 2.5 --drive-angle 90`
- Prevention:
  - Keep one known-good firmware profile for verification.

## 8) Semantic command accepted but not verified

- Symptom:
  - `serial_intent` returns `status=ok` but `verified=false/null`.
- Root cause:
  - No feedback field (`servo`/`motor_pwm`) or telemetry absent.
- Fix:
  - Restore telemetry first, then rerun semantic gate:
    - `powershell -ExecutionPolicy Bypass -File scripts/semantic_e2e_check.ps1`
- Prevention:
  - Never trust command acceptance alone; require post-action evidence.

## 9) Auto-probe fail streak high

- Symptom:
  - preflight warning: `auto-probe fail streak high`.
- Root cause:
  - Runtime keeps probing but firmware does not answer probe protocol.
- Fix:
  - Align firmware command protocol (STATUS?/IMU_ON/STREAM_ON/IMU?).
  - Or use compatible raw line control profile.
- Prevention:
  - Keep firmware/protocol matrix documented per board profile.

## 10) Release/merge decision drift

- Symptom:
  - Team debates publish/merge without consistent gates.
- Root cause:
  - No single machine-readable release decision.
- Fix:
  - Always run:
    - `npm run preflight-runtime`
    - `npm run self-verify`
  - Only proceed when:
    - publish: `publish_ready=true`
    - merge main: `merge_main_ready=true`
- Prevention:
  - Treat gate JSON as source of truth, not manual impression.
