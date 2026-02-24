import { spawn } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";

function parseArgs(argv) {
  const out = {
    host: "127.0.0.1",
    port: 9001,
    com: "COM3",
    baud: 115200,
    readDelayMs: 60,
    readTimeoutMs: 120,
    echo: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--host" && next) {
      out.host = next;
      i += 1;
      continue;
    }
    if (arg === "--port" && next) {
      out.port = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--com" && next) {
      out.com = next;
      i += 1;
      continue;
    }
    if (arg === "--baud" && next) {
      out.baud = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--read-delay-ms" && next) {
      out.readDelayMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--read-timeout-ms" && next) {
      out.readTimeoutMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--no-echo") {
      out.echo = false;
      continue;
    }
  }

  if (!Number.isFinite(out.port) || out.port <= 0) {
    throw new Error(`invalid --port: ${out.port}`);
  }
  if (!Number.isFinite(out.baud) || out.baud <= 0) {
    throw new Error(`invalid --baud: ${out.baud}`);
  }
  if (!Number.isFinite(out.readDelayMs) || out.readDelayMs < 0) {
    throw new Error(`invalid --read-delay-ms: ${out.readDelayMs}`);
  }
  if (!Number.isFinite(out.readTimeoutMs) || out.readTimeoutMs < 1) {
    throw new Error(`invalid --read-timeout-ms: ${out.readTimeoutMs}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(out.com)) {
    throw new Error(`invalid --com: ${out.com}`);
  }

  return out;
}

function toLogText(text) {
  return String(text).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

const POWERSHELL_SERIAL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$portName = $env:BRIDGE_COM
$baudRate = [int]$env:BRIDGE_BAUD
$readDelayMs = [int]$env:BRIDGE_READ_DELAY_MS
$readTimeoutMs = [int]$env:BRIDGE_READ_TIMEOUT_MS
$payload = [Console]::In.ReadToEnd()

$serial = New-Object System.IO.Ports.SerialPort($portName, $baudRate, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$serial.ReadTimeout = $readTimeoutMs
$serial.WriteTimeout = 500
$serial.NewLine = "\`n"
$serial.Open()
try {
  if ($payload.Length -gt 0) {
    $serial.Write($payload)
  }
  Start-Sleep -Milliseconds $readDelayMs
  $response = $serial.ReadExisting()
  if ($response) {
    [Console]::Out.Write($response)
  }
} finally {
  if ($serial -and $serial.IsOpen) {
    $serial.Close()
  }
}
`;

function writeToSerial(payload, options) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        POWERSHELL_SERIAL_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          BRIDGE_COM: options.com,
          BRIDGE_BAUD: String(options.baud),
          BRIDGE_READ_DELAY_MS: String(options.readDelayMs),
          BRIDGE_READ_TIMEOUT_MS: String(options.readTimeoutMs),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let closed = false;

    const finish = (result) => {
      if (closed) return;
      closed = true;
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish({
        ok: false,
        response: stdout,
        error: String(error),
      });
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish({
          ok: true,
          response: stdout,
          error: null,
        });
      } else {
        finish({
          ok: false,
          response: stdout,
          error: (stderr || `powershell exited with code ${code}`).trim(),
        });
      }
    });

    child.stdin.end(payload);
  });
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  let serialQueue = Promise.resolve();

  const server = createServer((socket) => {
    const peer = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? "?"}`;
    console.log(JSON.stringify({ type: "control_bridge_client_open", peer }));

    socket.on("data", (chunk) => {
      const payload = chunk.toString("utf8");
      console.log(
        JSON.stringify({
          type: "control_bridge_rx",
          peer,
          bytes: chunk.length,
          payload: toLogText(payload),
        }),
      );

      serialQueue = serialQueue
        .then(async () => {
          const result = await writeToSerial(payload, options);
          if (!result.ok) {
            console.error(
              JSON.stringify({
                type: "control_bridge_serial_error",
                peer,
                error: result.error,
              }),
            );
            if (socket.writable) {
              socket.write(
                `${JSON.stringify({
                  ok: false,
                  error: result.error,
                })}\n`,
              );
            }
            return;
          }

          if (result.response && result.response.length > 0) {
            console.log(
              JSON.stringify({
                type: "control_bridge_uno_rx",
                bytes: Buffer.byteLength(result.response, "utf8"),
                payload: toLogText(result.response),
              }),
            );
            if (options.echo && socket.writable) {
              const echoed = result.response.endsWith("\n")
                ? result.response
                : `${result.response}\n`;
              socket.write(echoed);
            }
            return;
          }

          if (options.echo && socket.writable) {
            socket.write('{"ok":true}\n');
          }
        })
        .catch((error) => {
          console.error(
            JSON.stringify({
              type: "control_bridge_unhandled_error",
              peer,
              error: String(error),
            }),
          );
          if (socket.writable) {
            socket.write(
              `${JSON.stringify({
                ok: false,
                error: String(error),
              })}\n`,
            );
          }
        });
    });

    socket.on("error", (error) => {
      console.error(
        JSON.stringify({
          type: "control_bridge_socket_error",
          peer,
          error: String(error),
        }),
      );
    });

    socket.on("close", () => {
      console.log(JSON.stringify({ type: "control_bridge_client_close", peer }));
    });
  });

  server.listen(options.port, options.host, () => {
    console.log(
      JSON.stringify({
        type: "control_bridge_listening",
        host: options.host,
        port: options.port,
        com: options.com,
        baud: options.baud,
        echo: options.echo,
      }),
    );
  });

  const shutdown = () => {
    server.close(() => {
      console.log(JSON.stringify({ type: "control_bridge_shutdown" }));
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

run().catch((error) => {
  console.error(
    JSON.stringify({
      type: "control_bridge_fatal",
      error: String(error),
    }),
  );
  process.exit(1);
});
