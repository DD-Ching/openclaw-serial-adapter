import { PythonLauncher } from "./src/launcher.js";
import { TelemetryClient, ControlClient } from "./src/tcp-client.js";
import type { PluginConfig } from "./src/types.js";

export type { PluginConfig, ReadyMessage, TelemetryFrame, AdapterStatus } from "./src/types.js";

interface OpenClawPluginApi {
  getConfig(): PluginConfig;
  registerService(service: {
    name: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }): void;
  registerTool(name: string, handler: ToolHandler): void;
}

interface ToolHandler {
  description: string;
  parameters?: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

let launcher: PythonLauncher | null = null;
let telemetryClient: TelemetryClient | null = null;
let controlClient: ControlClient | null = null;

async function connectAdapter(config: PluginConfig): Promise<Record<string, unknown>> {
  launcher = new PythonLauncher(config);
  const ready = await launcher.start();

  const host = config.host ?? "127.0.0.1";

  telemetryClient = new TelemetryClient();
  await telemetryClient.connect(host, ready.telemetry_port);

  controlClient = new ControlClient();
  await controlClient.connect(host, ready.control_port);

  return {
    status: "connected",
    telemetry_port: ready.telemetry_port,
    control_port: ready.control_port,
    pid: ready.pid,
  };
}

async function disconnectAdapter(): Promise<void> {
  telemetryClient?.disconnect();
  telemetryClient = null;
  controlClient?.disconnect();
  controlClient = null;
  await launcher?.stop();
  launcher = null;
}

export default {
  id: "serial-adapter",
  name: "Serial Adapter",
  description:
    "Serial device telemetry adapter with ring-buffer frame assembly and split TCP channels",

  async register(api: OpenClawPluginApi) {
    const config = api.getConfig();

    // -- Service: manages Python subprocess lifecycle --
    api.registerService({
      name: "serial-adapter",
      async start() {
        await connectAdapter(config);
      },
      async stop() {
        await disconnectAdapter();
      },
    });

    // -- Tool: serial_connect --
    api.registerTool("serial_connect", {
      description: "Connect to serial device and start telemetry adapter",
      parameters: {
        type: "object",
        properties: {
          port: {
            type: "string",
            description: "Serial port path (e.g. /dev/ttyUSB0)",
          },
          baudrate: {
            type: "number",
            description: "Baud rate (default 115200)",
          },
        },
      },
      async execute(params) {
        if (launcher?.isRunning()) {
          return { status: "already_connected" };
        }
        const dynamicConfig: PluginConfig = {
          ...config,
          serialPort: (params.port as string) ?? config.serialPort,
          baudrate: (params.baudrate as number) ?? config.baudrate,
        };
        return connectAdapter(dynamicConfig);
      },
    });

    // -- Tool: serial_poll --
    api.registerTool("serial_poll", {
      description: "Read available telemetry frames from serial adapter",
      parameters: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "Max number of frames to return",
          },
        },
      },
      async execute(params) {
        if (!telemetryClient) {
          return { error: "Not connected. Call serial_connect first." };
        }
        const frames = telemetryClient.pollFrames(
          params.count as number | undefined
        );
        return { frames, count: frames.length };
      },
    });

    // -- Tool: serial_send --
    api.registerTool("serial_send", {
      description: "Send a control command to serial device",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "object",
            description: "JSON command payload",
          },
        },
        required: ["command"],
      },
      async execute(params) {
        if (!controlClient) {
          return { error: "Not connected. Call serial_connect first." };
        }
        controlClient.sendCommand(
          params.command as Record<string, unknown>
        );
        return { status: "sent" };
      },
    });

    // -- Tool: serial_status --
    api.registerTool("serial_status", {
      description: "Get serial adapter runtime status",
      async execute() {
        if (!launcher?.isRunning()) {
          return { status: "disconnected" };
        }
        return {
          status: "connected",
          ready: launcher.getReadyMessage(),
        };
      },
    });
  },
};
