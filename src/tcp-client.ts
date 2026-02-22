import { createConnection, Socket } from "node:net";
import { createInterface, Interface } from "node:readline";
import type { TelemetryFrame } from "./types.js";

export class TelemetryClient {
  private socket: Socket | null = null;
  private rl: Interface | null = null;
  private frames: TelemetryFrame[] = [];
  private maxBuffered = 100;

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection({ host, port }, () => {
        this.rl = createInterface({ input: this.socket! });
        this.rl.on("line", (line) => {
          try {
            const frame = JSON.parse(line) as TelemetryFrame;
            this.frames.push(frame);
            if (this.frames.length > this.maxBuffered) {
              this.frames.shift();
            }
          } catch {
            // Skip malformed frames.
          }
        });
        resolve();
      });
      this.socket.on("error", reject);
    });
  }

  pollFrames(count?: number): TelemetryFrame[] {
    if (count !== undefined) {
      return this.frames.splice(0, count);
    }
    const result = this.frames;
    this.frames = [];
    return result;
  }

  disconnect(): void {
    this.rl?.close();
    this.rl = null;
    this.socket?.destroy();
    this.socket = null;
    this.frames = [];
  }
}

export class ControlClient {
  private socket: Socket | null = null;

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection({ host, port }, () => resolve());
      this.socket.on("error", reject);
    });
  }

  sendCommand(command: Record<string, unknown>): void {
    if (!this.socket) {
      throw new Error("Control client not connected");
    }
    const payload = JSON.stringify(command) + "\n";
    this.socket.write(payload);
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
