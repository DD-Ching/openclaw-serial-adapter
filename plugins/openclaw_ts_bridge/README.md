# openclaw_ts_bridge

Observer-mode runtime bridge:
- Reads telemetry JSON-lines from TCP (`127.0.0.1:9000` by default)
- Processes locally with `AlgorithmPipeline + SummarizerBlock` (optional PID block)
- Prints compact summary once per interval (default 1s)
- Accepts control-plane JSON commands from stdin to hot-update pipeline config

## Run

```bash
node plugins/openclaw_ts_bridge/bridge.js
```

```bash
node plugins/openclaw_ts_bridge/bridge.js --config plugins/openclaw_ts_bridge/config.json
```

## Control Plane Commands (stdin)

While bridge is running, paste one JSON command per line.

1) Change keys
```json
{"cmd":"set_keys","keys":["pos","velocity"]}
```

2) Change window
```json
{"cmd":"set_window","window":32}
```

3) Enable PID block
```json
{"cmd":"enable_block","block_name":"pid"}
```

Expected ACK format (example):
```json
{
  "type": "control_ack",
  "ok": true,
  "cmd": "set_window",
  "result": { "applied": true },
  "state": {
    "summary": { "window": 32, "interval_ms": 1000, "keys": ["pos","velocity"] },
    "active_blocks": ["summarizer","pid"]
  }
}
```

## Notes

- Summary output is JSON line `type=bridge_summary` every interval.
- No per-frame log output.
- Ctrl+C exits cleanly and prints `type=bridge_shutdown`.
- Command schema is in `plugins/openclaw_ts_bridge/command_schema.json`.
