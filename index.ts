import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import {
  PythonLauncher,
  listSerialPorts,
  chooseBestSerialPort,
} from "./src/launcher.js";
import { TelemetryClient, ControlClient } from "./src/tcp-client.js";
import type { PluginConfig } from "./src/types.js";

export type {
  PluginConfig,
  ReadyMessage,
  TelemetryFrame,
  AdapterStatus,
  SerialPortInfo,
} from "./src/types.js";

let launcher: PythonLauncher | null = null;
let telemetryClient: TelemetryClient | null = null;
let controlClient: ControlClient | null = null;
let log: OpenClawPluginApi["logger"];

const MOTION_TEMPLATES = [
  "slow_sway",
  "fast_jitter",
  "sweep",
  "center_stop",
] as const;
type MotionTemplateName = (typeof MOTION_TEMPLATES)[number];

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

type NormalizedSerialCommand =
  | {
      mode: "json";
      payload: Record<string, unknown>;
      source: string;
    }
  | {
      mode: "raw";
      payload: string;
      source: string;
    };

function normalizeSerialSendCommand(
  candidate: unknown
): NormalizedSerialCommand | null {
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return {
      mode: "json",
      payload: candidate as Record<string, unknown>,
      source: "json_object",
    };
  }

  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return {
      mode: "raw",
      payload: String(Math.trunc(candidate)),
      source: "numeric_scalar",
    };
  }

  if (typeof candidate !== "string") {
    return null;
  }

  const text = candidate.trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        mode: "json",
        payload: parsed as Record<string, unknown>,
        source: "json_string",
      };
    }
  } catch {
    // fall through to shorthand raw
  }

  const upper = text.toUpperCase();
  if (
    /^A-?\d{1,4}$/.test(upper) ||
    /^P-?\d{1,5}$/.test(upper) ||
    /^-?\d{1,4}$/.test(text)
  ) {
    return {
      mode: "raw",
      payload: upper.startsWith("A") || upper.startsWith("P") ? upper : text,
      source: "raw_shorthand",
    };
  }

  return {
    mode: "raw",
    payload: text,
    source: "raw_text",
  };
}

function compactPortInfo(configuredPort: string | null, allPorts: ReturnType<PythonLauncher["getLastProbePorts"]>) {
  return {
    selected: configuredPort,
    available: allPorts.map((port) => port.device),
  };
}

function buildMotionSequence(
  template: MotionTemplateName,
  options: {
    minPwm: number;
    maxPwm: number;
    centerPwm: number;
  }
): number[] {
  const minPwm = clamp(options.minPwm, 500, 2500);
  const maxPwm = clamp(options.maxPwm, 500, 2500);
  const centerPwm = clamp(options.centerPwm, 500, 2500);

  switch (template) {
    case "slow_sway":
      return [minPwm, centerPwm, maxPwm, centerPwm];
    case "fast_jitter":
      return [
        centerPwm - 120,
        centerPwm + 120,
        centerPwm - 80,
        centerPwm + 80,
        centerPwm,
      ].map((value) => clamp(value, 500, 2500));
    case "sweep":
      return [minPwm, maxPwm];
    case "center_stop":
      return [centerPwm, 0];
    default:
      return [centerPwm];
  }
}

async function connectAdapter(config: PluginConfig) {
  launcher = new PythonLauncher(config);
  const ready = await launcher.start();

  const host = config.host ?? "127.0.0.1";
  const resolvedPort = launcher.getResolvedPort() ?? config.serialPort ?? null;
  const portInfo = compactPortInfo(resolvedPort, launcher.getLastProbePorts());

  telemetryClient = new TelemetryClient();
  controlClient = new ControlClient();
  try {
    await telemetryClient.connect(host, ready.telemetry_port);
    await controlClient.connect(host, ready.control_port);
  } catch (error) {
    telemetryClient?.disconnect();
    telemetryClient = null;
    controlClient?.disconnect();
    controlClient = null;
    await launcher.stop();
    launcher = null;
    throw new Error(
      [
        "Adapter subprocess started, but channel attachment failed.",
        toErrorMessage(error),
      ].join(" ")
    );
  }

  const result = {
    status: "connected" as const,
    serial_port: resolvedPort,
    serial_ports_available: portInfo.available,
    telemetry_port: ready.telemetry_port,
    control_port: ready.control_port,
    pid: ready.pid,
  };
  log.info(
    JSON.stringify({
      event: "serial_adapter_connected",
      serial_port: result.serial_port,
      serial_ports_available: result.serial_ports_available,
      telemetry_port: result.telemetry_port,
      control_port: result.control_port,
      pid: result.pid,
    })
  );
  return result;
}

async function disconnectAdapter() {
  telemetryClient?.disconnect();
  telemetryClient = null;
  controlClient?.disconnect();
  controlClient = null;
  await launcher?.stop();
  launcher = null;
  log.info(
    JSON.stringify({
      event: "serial_adapter_disconnected",
    })
  );
}

const plugin = {
  id: "serial-adapter",
  name: "Serial Adapter",
  description:
    "Serial device telemetry adapter with ring-buffer frame assembly and split TCP channels",

  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as unknown as PluginConfig;
    log = api.logger;

    api.registerService({
      id: "serial-adapter",
      async start() {
        const autoDetect = config.autoDetectSerialPort !== false;
        if (!config.serialPort && !autoDetect) {
          log.info(
            "serialPort is not configured and autoDetectSerialPort=false. Service stays idle until serial_connect."
          );
          return;
        }
        try {
          await connectAdapter(config);
        } catch (error) {
          // Service should not crash the full gateway on boot.
          log.warn(
            JSON.stringify({
              event: "serial_adapter_autostart_skipped",
              error: toErrorMessage(error),
              next_step:
                "Run serial_probe, ensure COM is not occupied, then call serial_connect.",
            })
          );
        }
      },
      async stop() {
        await disconnectAdapter();
      },
    });

    api.registerTool({
      name: "serial_probe",
      label: "Probe Serial",
      description: "List serial ports and suggest a likely device port",
      parameters: Type.Object({
        portHints: Type.Optional(
          Type.Array(Type.String({ description: "Port matching hint" }))
        ),
      }),
      async execute(_toolCallId, params) {
        try {
          const probeConfig: PluginConfig = {
            ...config,
            portHints: params.portHints ?? config.portHints,
          };
          const ports = await listSerialPorts(probeConfig);
          const suggested = chooseBestSerialPort(ports, probeConfig.portHints);
          return jsonResult({
            ports,
            suggested: suggested?.device ?? null,
          });
        } catch (error) {
          return jsonResult({
            error: toErrorMessage(error),
            next_step:
              "Ensure Python + pyserial are available, then run serial_probe again.",
          });
        }
      },
    });

    api.registerTool({
      name: "serial_connect",
      label: "Connect Serial",
      description:
        "Connect to serial device and start telemetry adapter (supports auto-detect)",
      parameters: Type.Object({
        port: Type.Optional(
          Type.String({ description: "Serial port path (e.g. COM3 or /dev/ttyUSB0)" })
        ),
        baudrate: Type.Optional(
          Type.Number({ description: "Baud rate (default 115200)" })
        ),
        autoDetect: Type.Optional(
          Type.Boolean({ description: "Enable auto serial port detection" })
        ),
        portHints: Type.Optional(
          Type.Array(Type.String({ description: "Port matching hint" }))
        ),
      }),
      async execute(_toolCallId, params) {
        if (launcher?.isRunning()) {
          return jsonResult({ status: "already_connected" });
        }

        const dynamicConfig: PluginConfig = {
          ...config,
          serialPort: params.port ?? config.serialPort,
          baudrate: params.baudrate ?? config.baudrate,
          autoDetectSerialPort:
            params.autoDetect ?? config.autoDetectSerialPort ?? true,
          portHints: params.portHints ?? config.portHints,
        };

        try {
          return jsonResult(await connectAdapter(dynamicConfig));
        } catch (error) {
          return jsonResult({
            error: toErrorMessage(error),
            next_step:
              "Run serial_probe, close Arduino Serial Monitor/uploader on the same COM, then retry serial_connect.",
          });
        }
      },
    });

    api.registerTool({
      name: "serial_poll",
      label: "Poll Telemetry",
      description: "Read available telemetry frames from serial adapter",
      parameters: Type.Object({
        count: Type.Optional(
          Type.Number({ description: "Max number of frames to return" })
        ),
      }),
      async execute(_toolCallId, params) {
        if (!telemetryClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }
        const frames = telemetryClient.pollFrames(params.count);
        return jsonResult({ frames, count: frames.length });
      },
    });

    api.registerTool({
      name: "serial_send",
      label: "Send Command",
      description: "Send a control command to serial device",
      parameters: Type.Object({
        command: Type.Unknown({
          description:
            "Control payload. Supports JSON object or shorthand text (A90/P1500/90).",
        }),
      }),
      async execute(_toolCallId, params) {
        if (!controlClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }
        const normalized = normalizeSerialSendCommand(params.command);
        if (!normalized) {
          return jsonResult({
            error:
              "Invalid command format. Use JSON object or shorthand text (A90/P1500/90).",
          });
        }

        if (normalized.mode === "json") {
          controlClient.sendCommand(normalized.payload);
        } else {
          controlClient.sendRawLine(normalized.payload);
        }

        return jsonResult({
          status: "sent",
          mode: normalized.mode,
          source: normalized.source,
          normalized: normalized.payload,
        });
      },
    });

    api.registerTool({
      name: "serial_motion_template",
      label: "Servo Motion Template",
      description:
        "Run built-in servo motion templates (slow_sway, fast_jitter, sweep, center_stop)",
      parameters: Type.Object({
        template: Type.Union(
          MOTION_TEMPLATES.map((name) => Type.Literal(name)),
          { description: "Built-in motion template name" }
        ),
        repeats: Type.Optional(
          Type.Number({ description: "How many times to replay the template", minimum: 1 })
        ),
        intervalMs: Type.Optional(
          Type.Number({ description: "Delay between PWM writes (ms)", minimum: 10 })
        ),
        minPwm: Type.Optional(
          Type.Number({ description: "Lower PWM bound", minimum: 500, maximum: 2500 })
        ),
        maxPwm: Type.Optional(
          Type.Number({ description: "Upper PWM bound", minimum: 500, maximum: 2500 })
        ),
        centerPwm: Type.Optional(
          Type.Number({ description: "Center PWM", minimum: 500, maximum: 2500 })
        ),
      }),
      async execute(_toolCallId, params) {
        if (!controlClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }

        const template = params.template as MotionTemplateName;
        const repeats = Math.max(1, Math.floor(params.repeats ?? 1));
        const intervalMs = Math.max(10, Math.floor(params.intervalMs ?? 350));
        const sequence = buildMotionSequence(template, {
          minPwm: params.minPwm ?? 1100,
          maxPwm: params.maxPwm ?? 1900,
          centerPwm: params.centerPwm ?? 1500,
        });

        for (let r = 0; r < repeats; r += 1) {
          for (const pwm of sequence) {
            controlClient.sendCommand({ motor_pwm: pwm });
            await sleep(intervalMs);
          }
        }

        return jsonResult({
          status: "sent",
          template,
          repeats,
          intervalMs,
          sequence,
          totalCommands: sequence.length * repeats,
        });
      },
    });

    api.registerTool({
      name: "serial_status",
      label: "Adapter Status",
      description: "Get serial adapter runtime status",
      parameters: Type.Object({}),
      async execute() {
        if (!launcher?.isRunning()) {
          return jsonResult({ status: "disconnected" });
        }
        return jsonResult({
          status: "connected",
          port: launcher.getResolvedPort() ?? config.serialPort ?? null,
          ready: launcher.getReadyMessage(),
        });
      },
    });

    api.registerTool({
      name: "serial_pause",
      label: "Pause Serial",
      description:
        "Temporarily release COM for firmware upload (adapter stays alive)",
      parameters: Type.Object({
        seconds: Type.Optional(
          Type.Number({
            description: "Pause duration seconds (default 25, 0 = manual resume)",
            minimum: 0,
          })
        ),
      }),
      async execute(_toolCallId, params) {
        if (!controlClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }
        const holdS =
          typeof params.seconds === "number"
            ? Math.max(0, Math.min(params.seconds, 300))
            : 25;
        controlClient.sendCommand({
          __adapter_cmd: "pause",
          hold_s: holdS > 0 ? holdS : undefined,
        });
        return jsonResult({
          status: "pause_requested",
          hold_s: holdS > 0 ? holdS : null,
        });
      },
    });

    api.registerTool({
      name: "serial_resume",
      label: "Resume Serial",
      description: "Re-open COM after upload",
      parameters: Type.Object({}),
      async execute() {
        if (!controlClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }
        controlClient.sendCommand({ __adapter_cmd: "resume" });
        return jsonResult({ status: "resume_requested" });
      },
    });
  },
};

export default plugin;
