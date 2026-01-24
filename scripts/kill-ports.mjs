/**
 * Kill any process occupying the dev ports (3001, 5173) before starting.
 * Uses PowerShell Get-NetTCPConnection for reliable port detection on Windows.
 */
import { execSync } from "child_process";

const PORTS = [3001, 5173];

for (const port of PORTS) {
  try {
    const ps = `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`;
    const output = execSync(`powershell -NoProfile -Command "${ps}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pids = new Set(
      output.trim().split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== "0")
    );
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "pipe" });
        console.info(`[kill-ports] killed PID ${pid} on port ${port}`);
      } catch {
        // process may have already exited
      }
    }
  } catch {
    // no process on this port — good
  }
}
