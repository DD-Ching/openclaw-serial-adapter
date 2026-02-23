import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { PythonLauncher } from "./src/launcher.js";
import { TelemetryClient, ControlClient } from "./src/tcp-client.js";
import type { PluginConfig } from "./src/types.js";

export type {
  PluginConfig,
  ReadyMessage,
  TelemetryFrame,
  AdapterStatus,
} from "./src/types.js";

let launcher: PythonLauncher | null = null;
let telemetryClient: TelemetryClient | null = null;
let controlClient: ControlClient | null = null;
let log: OpenClawPluginApi["logger"];

async function connectAdapter(config: PluginConfig) {
  launcher = new PythonLauncher(config);
  const ready = await launcher.start();

  const host = config.host ?? "127.0.0.1";

  telemetryClient = new TelemetryClient();
  await telemetryClient.connect(host, ready.telemetry_port);

  controlClient = new ControlClient();
  await controlClient.connect(host, ready.control_port);

  const result = {
    status: "connected" as const,
    telemetry_port: ready.telemetry_port,
    control_port: ready.control_port,
    pid: ready.pid,
  };
  log.info(
    `Adapter connected on telemetry:${ready.telemetry_port} control:${ready.control_port}`
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
  log.info("Adapter disconnected");
}

const plugin = {
  id: "serial-adapter",
  name: "Serial Adapter",
  description:
    "Serial device telemetry adapter with ring-buffer frame assembly and split TCP channels",

  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as unknown as PluginConfig;
    log = api.logger;

    // -- Service: manages Python subprocess lifecycle --
    api.registerService({
      id: "serial-adapter",
      async start() {
        if (!config.serialPort) {
          log.info(
            "serialPort is not configured. Service will stay idle until serial_connect is called."
          );
          return;
        }
        await connectAdapter(config);
      },
      async stop() {
        await disconnectAdapter();
      },
    });

    // -- Tool: serial_connect --
    api.registerTool({
      name: "serial_connect",
      label: "Connect Serial",
      description: "Connect to serial device and start telemetry adapter",
      parameters: Type.Object({
        port: Type.Optional(
          Type.String({ description: "Serial port path (e.g. /dev/ttyUSB0)" })
        ),
        baudrate: Type.Optional(
          Type.Number({ description: "Baud rate (default 115200)" })
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
        };
        if (!dynamicConfig.serialPort) {
          return jsonResult({
            error:
              "No serial port configured. Set plugins.entries.serial-adapter.config.serialPort or pass port.",
          });
        }
        return jsonResult(await connectAdapter(dynamicConfig));
      },
    });

    // -- Tool: serial_poll --
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

    // -- Tool: serial_send --
    api.registerTool({
      name: "serial_send",
      label: "Send Command",
      description: "Send a control command to serial device",
      parameters: Type.Object({
        command: Type.Record(Type.String(), Type.Unknown(), {
          description: "JSON command payload",
        }),
      }),
      async execute(_toolCallId, params) {
        if (!controlClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }
        controlClient.sendCommand(params.command as Record<string, unknown>);
        return jsonResult({ status: "sent" });
      },
    });

    // -- Tool: serial_status --
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
          ready: launcher.getReadyMessage(),
        });
      },
    });
  },
};

export default plugin;
