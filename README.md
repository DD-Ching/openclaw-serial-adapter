# OpenClaw Serial Adapter

Universal telemetry adapter plugin for OpenClaw, supporting serial device ingestion with buffered frame parsing and split TCP interfaces for telemetry and control.

## Overview

`@openclaw/serial-adapter` reads line-delimited serial telemetry, reconstructs fragmented frames with a ring buffer, and exposes data to local clients and automation tools.

The TypeScript plugin spawns a Python subprocess that handles the serial I/O and TCP servers, then bridges telemetry and control through OpenClaw tool registrations.

## Features

- RingBuffer-based frame assembly for fragmented serial input
- TCP telemetry stream (read-only broadcast, default `9000`)
- TCP control channel (write-only commands, default `9001`)
- Observer API (`poll`, `poll_all`, `register_callback`, `get_latest_frame`, `get_last_n_frames`)
- Control safety enforcement (`unsafe_passthrough`, allowlist, rate limiting)
- Runtime status reporting (`get_status`)
- Stability tested with long-duration 100Hz telemetry run

## Installation

```bash
openclaw plugins install @openclaw/serial-adapter
```

### Prerequisites

- Python 3.10+ with `pyserial` installed on the host machine
- Node.js 18+

## Plugin Configuration

Add to your OpenClaw project config:

```json
{
  "plugins": {
    "serial-adapter": {
      "serialPort": "/dev/ttyUSB0",
      "baudrate": 115200,
      "telemetryPort": 9000,
      "controlPort": 9001
    }
  }
}
```

### Config Options

| Option | Type | Default | Description |
|---|---|---|---|
| `serialPort` | string | *required* | Serial device path |
| `baudrate` | number | `115200` | Serial baud rate |
| `telemetryPort` | number | `9000` | TCP telemetry broadcast port |
| `controlPort` | number | `9001` | TCP control command port |
| `host` | string | `127.0.0.1` | TCP bind host |
| `pythonPath` | string | `python3` | Python interpreter path |
| `unsafePassthrough` | boolean | `false` | Allow all control keys |
| `allowedCommands` | string[] | `["motor_pwm", "target_velocity"]` | Command allowlist |
| `maxControlRate` | number | `50` | Max control commands per second |

## Registered Tools

| Tool | Description |
|---|---|
| `serial_connect` | Connect to serial device and start adapter |
| `serial_poll` | Read available telemetry frames |
| `serial_send` | Send a control command to serial device |
| `serial_status` | Get adapter runtime status |

## Development

### Run self-test

```bash
python -m python.self_test
```

### Monitor telemetry (standalone)

```bash
python examples/tcp_monitor.py --host 127.0.0.1 --port 9000
```

### Send control command (standalone)

```bash
python examples/tcp_control.py --host 127.0.0.1 --port 9001 --command "{\"target_velocity\":1.5}"
```

### Build TypeScript

```bash
npm install
npm run build
```

## Architecture

```
OpenClaw Gateway
  └─ serial-adapter plugin (TypeScript)
       ├─ register() registers tools + service
       ├─ service.start() → spawn python3 subprocess
       │    └─ Python SerialAdapter
       │         ├─ Serial port reader thread
       │         ├─ TCP telemetry server :9000
       │         └─ TCP control server :9001
       ├─ serial_poll tool → TCP client reads :9000
       ├─ serial_send tool → TCP client writes :9001
       └─ service.stop() → SIGTERM subprocess
```

## Additional Documentation

- Protocol: `docs/protocol.md`
- Architecture: `docs/architecture.md`
