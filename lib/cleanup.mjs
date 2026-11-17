// Leftovers worth deleting: Remotion's temporary bundles and render folders (they stay behind when a render is stopped or
// crashes) and the frame pictures Dailies made for Claude's checks. Never touches your renders or your project.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

const sizeOf = (p) => {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    let s = 0;
    for (const e of readdirSync(p)) s += sizeOf(join(p, e));
    return s;
  } catch {
    return 0;
  }
};

const REMOTION_TMP = /^(remotion-webpack-bundle-|remotion-v[\d.]+-assets|react-motion-render)/;

export const findLeftovers = (dailiesDir) => {
  const items = [];
  const tmp = os.tmpdir();
  try {
    for (const n of readdirSync(tmp)) {
      if (REMOTION_TMP.test(n)) items.push({ kind: "remotion", path: join(tmp, n), bytes: sizeOf(join(tmp, n)) });
    }
  } catch {
    /* no temp folder access */
  }
  const frames = join(dailiesDir, "frames");
  if (existsSync(frames)) items.push({ kind: "frames", path: frames, bytes: sizeOf(frames) });
  return items.filter((i) => i.bytes > 0);
};

// Remotion's temp folders belong to a running render or Studio: never delete them while one is running anywhere
export const remotionRunning = () => {
  try {
    if (process.platform === "win32") {
      return /remotion/i.test(execFileSync("wmic", ["process", "get", "commandline"], { encoding: "utf8" }));
    }
    const out = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
    // the real processes only (the Remotion CLI under node, or its compositor), not a shell that merely mentions them
    return out.split("\n").some((l) => /(node_modules\/\.bin\/remotion|@remotion\/cli\/|@remotion\/compositor-)/.test(l) && !l.includes("dailies"));
  } catch {
    return false;
  }
};

export const removeLeftovers = (items) => {
  let freed = 0;
  for (const it of items) {
    try {
      rmSync(it.path, { recursive: true, force: true });
      freed += it.bytes;
    } catch {
      /* in use or gone */
    }
  }
  return freed;
};
