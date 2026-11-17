// "Render once": the real Remotion CLI with safe settings (1 thread), live progress and memory,
// then every frame of the result is checked for broken ones (a frame unlike both neighbours
// while the neighbours match each other: black flashes and corrupted tiles).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readMemory } from "./memory.mjs";

const WIN = process.platform === "win32";
// Windows runs npx through npx.cmd, which Node only starts with a shell; quote what needs quoting
const npx = (args, opts) => spawn(WIN ? "npx.cmd" : "npx", WIN ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args, { ...opts, shell: WIN });

export const checkFrames = ({ root, file, onProgress }) =>
  new Promise((resolve, reject) => {
    const W = 160, H = 90, SIZE = W * H;
    // Remotion's bundled ffmpeg has no "rawvideo" muxer; image2pipe + the rawvideo codec gives the same bytes
    const ff = npx(["remotion", "ffmpeg", "-v", "error", "-i", file, "-vf", `scale=${W}:${H},format=gray`, "-f", "image2pipe", "-c:v", "rawvideo", "-"], { cwd: root });
    let buf = Buffer.alloc(0);
    const win = [];
    const broken = [];
    let n = 0;
    const diff = (a, b) => {
      let s = 0;
      for (let i = 0; i < SIZE; i++) s += Math.abs(a[i] - b[i]);
      return s / SIZE;
    };
    ff.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= SIZE) {
        win.push(Uint8Array.from(buf.subarray(0, SIZE)));
        buf = buf.subarray(SIZE);
        n++;
        if (win.length > 3) win.shift();
        if (win.length === 3) {
          const [a, b, c] = win;
          const dab = diff(b, a), dbc = diff(b, c), dac = diff(a, c);
          if (dab > 15 && dbc > 15 && dac < 0.5 * Math.min(dab, dbc)) broken.push(n - 2);
        }
        if (n % 120 === 0) onProgress?.(n);
      }
    });
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve({ frames: n, broken }) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
  });

export const startRender = ({ root, composition, totalFrames, onUpdate }) => {
  const outDir = join(root, "out");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${composition}.mp4`);
  const job = {
    id: Date.now(), composition, out: relative(root, out), status: "bundling",
    rendered: 0, total: totalFrames ?? null, eta: null, startedAt: Date.now(), finishedAt: null,
    memory: readMemory(), minFreeMB: null, maxSwapGB: null, check: null, error: null, log: [],
  };
  const touch = () => onUpdate?.({ ...job, log: job.log.slice(-6) });
  const sample = () => {
    const m = readMemory();
    if (!m) return;
    job.memory = m;
    job.minFreeMB = job.minFreeMB === null ? m.freeMB : Math.min(job.minFreeMB, m.freeMB);
    job.maxSwapGB = job.maxSwapGB === null ? m.swapUsedGB : Math.max(job.maxSwapGB, m.swapUsedGB);
    touch();
  };
  const memTimer = setInterval(sample, 2000);
  sample();

  // --concurrency=1: on an 8 GB M1, two render threads produced black frames (2 in 1,200 in our test)
  const proc = npx(["remotion", "render", composition, out, "--concurrency=1", "--log=info"], {
    cwd: root, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  job.cancel = () => {
    job.cancelled = true;
    proc.kill("SIGINT");
  };
  const onText = (text) => {
    for (const line of text.split(/[\r\n]+/)) {
      const l = line.trim();
      if (!l) continue;
      job.log.push(l);
      if (job.log.length > 200) job.log.shift();
      const r = l.match(/Rendered (\d+)\/(\d+)(?:,\s*time remaining:\s*(.+))?/i);
      if (r) {
        job.status = "rendering";
        job.rendered = Number(r[1]);
        job.total = Number(r[2]);
        job.eta = r[3]?.trim() ?? null;
      } else if (/Encod/i.test(l) && job.status === "rendering" && job.rendered === job.total) {
        job.status = "encoding";
      }
    }
    touch();
  };
  proc.stdout.on("data", (d) => onText(d.toString()));
  proc.stderr.on("data", (d) => onText(d.toString()));
  proc.on("close", async (code) => {
    clearInterval(memTimer);
    if (job.cancelled || code !== 0 || !existsSync(out)) {
      job.status = job.cancelled ? "cancelled" : "failed";
      job.error = job.cancelled ? null : job.log.slice(-4).join("\n") || `remotion exited with code ${code}`;
      job.finishedAt = Date.now();
      touch();
      return;
    }
    job.status = "checking";
    job.rendered = job.total ?? job.rendered;
    touch();
    try {
      job.check = await checkFrames({ root, file: out, onProgress: (n) => { job.checked = n; touch(); } });
      job.sizeMB = statSync(out).size / 1048576;
      job.status = "done";
    } catch (e) {
      job.status = "failed";
      job.error = `Frame check failed: ${e.message}`;
    }
    job.finishedAt = Date.now();
    touch();
  });
  return job;
};

export const outDirOf = (root, job) => dirname(join(root, job.out));
