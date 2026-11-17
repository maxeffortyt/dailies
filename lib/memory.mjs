// How much memory the computer has left (macOS: vm_stat + sysctl, with swap and the kernel's memory-pressure level;
// elsewhere what Node reports). Shown live while a film renders; the render queue waits while memory is critical.
import { execFileSync } from "node:child_process";
import os from "node:os";

// macOS keeps its own verdict: 1 = normal, 2 = warning, 4 = critical
const macPressure = () => {
  try {
    const v = Number(execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8" }).trim());
    return v >= 4 ? "critical" : v >= 2 ? "warning" : "normal";
  } catch {
    return "normal";
  }
};

export const readMemory = () => {
  if (process.platform !== "darwin") {
    // Windows / Linux: free memory and total as the OS reports them
    const total = os.totalmem(), free = os.freemem();
    const share = free / total;
    return {
      totalGB: total / 1073741824, freeMB: Math.round(free / 1048576), usedGB: (total - free) / 1073741824, swapUsedGB: null,
      pressure: share < 0.05 ? "critical" : share < 0.1 ? "warning" : "normal",
    };
  }
  try {
    const vm = execFileSync("vm_stat", { encoding: "utf8" });
    const pageSize = Number(vm.match(/page size of (\d+)/)?.[1] ?? 16384);
    const pages = (label) => Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
    const totalBytes = Number(execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).trim());
    const swap = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" });
    const swapUsedMB = Number(swap.match(/used = ([\d.]+)M/)?.[1] ?? 0);
    const gb = (p) => (p * pageSize) / 1073741824;
    return {
      totalGB: totalBytes / 1073741824,
      freeMB: Math.round((pages("Pages free") * pageSize) / 1048576),
      // Activity Monitor's "Memory Used" = app memory + wired + compressed
      usedGB: gb(pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor")),
      swapUsedGB: swapUsedMB / 1024,
      pressure: macPressure(),
    };
  } catch {
    return null;
  }
};
