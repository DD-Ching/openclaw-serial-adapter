#!/usr/bin/env node
/**
 * postinstall — set up a Python virtualenv with dependencies via uv.
 *
 * If `uv` is available, runs `uv sync --frozen --no-dev` to create a
 * local .venv with pyserial installed.  If `uv` is not found, prints
 * a helpful message and exits successfully (npm install must not fail).
 */

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function hasCommand(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasCommand("uv")) {
  console.log(
    [
      "",
      "[serial-adapter] 'uv' not found — skipping Python env setup.",
      "",
      "  To auto-install Python dependencies, install uv first:",
      "    curl -LsSf https://astral.sh/uv/install.sh | sh",
      "",
      "  Or install pyserial manually:",
      "    pip install pyserial",
      "",
    ].join("\n")
  );
  process.exit(0);
}

try {
  console.log("[serial-adapter] Setting up Python environment...");
  execFileSync("uv", ["sync", "--frozen", "--no-dev"], {
    cwd: root,
    stdio: "inherit",
  });
  console.log("[serial-adapter] Python environment ready.");
} catch (err) {
  console.warn(
    `[serial-adapter] uv sync failed: ${err.message}\n` +
      "  You may need to run 'pip install pyserial' manually."
  );
}
