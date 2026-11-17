#!/usr/bin/env node
// Dailies: review your Remotion film from code, frame by frame. Circle what's wrong; Claude gets the note.
// Run it inside a Remotion project:  node /path/to/dailies/bin/dailies.mjs
// It plays the film live from your code (no render), reloads when the code changes,
// keeps notes in .dailies/ and talks to Claude Code through the dailies MCP server (bin/mcp.mjs).
import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { findLeftovers, remotionRunning, removeLeftovers } from "../lib/cleanup.mjs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, findEntry, findProject, findPublicDir, projectRequire, resolveFromProject } from "../lib/project.mjs";
import { dailiesDir, loadNotes, nextId, saveNotes } from "../lib/notes.mjs";
import { connectToPage } from "../lib/cdp.mjs";
import { readMemory } from "../lib/memory.mjs";
import { startRender } from "../lib/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAILIES = resolve(HERE, "..");
const VERSION = JSON.parse(readFileSync(join(DAILIES, "package.json"), "utf8")).version;

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const PORT = Number(opt("port", 4545));
const DEVTOOLS_PORT = Number(opt("devtools-port", PORT + 1));
const fail = (msg) => {
  console.error(`Dailies: ${msg}`);
  process.exit(1);
};

const project = findProject(opt("project", process.cwd()));
if (!project) fail("no Remotion project here (no package.json that depends on remotion). Run Dailies inside your Remotion project.");
const ROOT = project.root;
const ENTRY = findEntry(ROOT);
if (!ENTRY) fail(`can't find the Remotion entry point in ${ROOT} (looked for src/index.ts and Config.setEntryPoint).`);
const PUBLIC = findPublicDir(ROOT);
const DIR = dailiesDir(ROOT);
const BUILD = join(DIR, "build");

// ---------- build: the project's own esbuild bundles the Dailies app together with the film's code ----------
const esbuildPath = resolveFromProject(ROOT, "esbuild") ??
  (() => {
    const bundlerPkg = resolveFromProject(ROOT, "@remotion/bundler/package.json");
    return bundlerPkg ? projectRequire(dirname(bundlerPkg)).resolve("esbuild") : null;
  })();
if (!esbuildPath) fail("esbuild not found. Run `npm install` in your Remotion project first.");
if (!resolveFromProject(ROOT, "@remotion/player/package.json")) {
  fail("@remotion/player not found. Install the same version as remotion: npx remotion add @remotion/player");
}
const esbuild = projectRequire(ROOT)(esbuildPath);
const CLIENT = join(DAILIES, "client");

const dailiesPlugin = {
  name: "dailies",
  setup(build) {
    // the film's entry point (it calls registerRoot)
    build.onResolve({ filter: /^dailies:project-entry$/ }, () => ({ path: ENTRY }));
    // every `import ... from "remotion"` goes through a thin shim that records <Composition>s and registerRoot
    build.onResolve({ filter: /^remotion$/ }, (a) => (a.pluginData?.real ? undefined : { path: join(CLIENT, "remotion-shim.tsx") }));
    build.onResolve({ filter: /^dailies:real-remotion$/ }, () =>
      build.resolve("remotion", { kind: "import-statement", resolveDir: ROOT, pluginData: { real: true } }));
    // bare imports from the Dailies app resolve from the project, so React and Remotion exist exactly once
    build.onResolve({ filter: /^[^./]/ }, (a) => {
      if (a.pluginData?.fromRoot || !(a.importer ?? "").startsWith(CLIENT) || a.path.startsWith("dailies:")) return undefined;
      return build.resolve(a.path, { kind: a.kind, resolveDir: ROOT, pluginData: { fromRoot: true, real: a.pluginData?.real } });
    });
    let first = true;
    build.onEnd((result) => {
      if (result.errors.length) {
        const text = esbuild.formatMessagesSync(result.errors, { kind: "error", color: false }).join("\n");
        console.error(text);
        broadcast("build-error", { text });
      } else {
        if (!first) console.log(`Dailies: code changed, reloading (${new Date().toLocaleTimeString()})`);
        broadcast("reload", {});
      }
      first = false;
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: { main: join(CLIENT, "main.tsx") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  outdir: BUILD,
  publicPath: "/__dailies/build/",
  jsx: "automatic",
  sourcemap: "linked",
  define: { "process.env.NODE_ENV": '"production"' },
  banner: { js: "globalThis.process ??= { env: { NODE_ENV: 'production' } };" },
  loader: Object.fromEntries([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".mp4", ".webm", ".mov",
    ".woff", ".woff2", ".ttf", ".otf", ".glb", ".gltf", ".bin", ".lottie"].map((e) => [e, "file"]).concat([[".txt", "text"], [".md", "text"], [".srt", "text"], [".vtt", "text"]])),
  assetNames: "assets/[name]-[hash]",
  absWorkingDir: ROOT,
  nodePaths: [join(ROOT, "node_modules")],
  logLevel: "silent",
  plugins: [dailiesPlugin],
});

// ---------- server ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".map": "application/json", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".aac": "audio/aac", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf",
};
const sendFile = (req, res, file) => {
  const st = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Number(range[2]) : st.size - 1;
    if (!range[1] && range[2]) [start, end] = [st.size - Number(range[2]), st.size - 1];
    if (start >= st.size || end >= st.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
  createReadStream(file).pipe(res);
};
const inside = (base, rel) => {
  let p;
  try {
    p = normalize(join(base, decodeURIComponent(rel)));
  } catch {
    return null;
  }
  return p.startsWith(base + sep) && existsSync(p) && statSync(p).isFile() ? p : null;
};
const json = (res, code, data) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
  res.end(JSON.stringify(data));
};
const body = (req) =>
  new Promise((res, rej) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      try {
        res(s ? JSON.parse(s) : {});
      } catch (e) {
        rej(e);
      }
    });
  });

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  for (const c of clients) c.write(msg);
}

const INDEX = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dailies</title>
<link rel="stylesheet" href="/__dailies/build/main.css"></head>
<body><div id="root"></div>
<script>
  const es = new EventSource('/__dailies/events');
  window.__dailiesEvents = es;
  es.addEventListener('reload', () => { try { window.__dailiesBeforeReload && window.__dailiesBeforeReload(); } catch (e) {} location.reload(); });
  es.addEventListener('build-error', (e) => {
    const text = JSON.parse(e.data).text;
    if (window.__dailiesShowError) return window.__dailiesShowError(text);
    document.body.innerHTML = '<pre style="color:#FF5D5D;background:#0D1021;margin:0;min-height:100vh;padding:28px;white-space:pre-wrap;font:14px/1.5 SF Mono,Menlo,monospace">' + text.replace(/</g, '&lt;') + '</pre>';
  });
</script>
<script type="module" src="/__dailies/build/main.js"></script>
</body></html>`;

// ---------- frame captures through the Dailies window itself (exactly what you see, at composition scale) ----------
let cdp = null;
const getCdp = async () => {
  if (!cdp) cdp = await connectToPage({ root: ROOT, port: DEVTOOLS_PORT, urlPrefix: `http://localhost:${PORT}` });
  return cdp;
};
let captureChain = Promise.resolve();
const capture = (opts) => {
  const run = async () => {
    const { composition, frame, clean, file, width = 1280 } = opts;
    try {
      const c = await getCdp();
      const rect = await c.evaluate(`window.__dailies.prepareCapture(${JSON.stringify({ composition, frame, clean: !!clean })})`);
      const shot = await c.send("Page.captureScreenshot", {
        format: "png", clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: width / rect.width },
      });
      await c.evaluate("window.__dailies.finishCapture()");
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      return file;
    } catch (e) {
      cdp?.close?.();
      cdp = null;
      throw e;
    }
  };
  captureChain = captureChain.then(run, run);
  return captureChain;
};

// ---------- render queue: one render at a time, on one thread; the next one waits while memory is critical ----------
let job = null;
const queue = [];
let waiting = null;
const RENDERS = join(DIR, "renders.json");
let renders = (() => {
  try {
    return JSON.parse(readFileSync(RENDERS, "utf8"));
  } catch {
    return [];
  }
})();
const publicJob = () => (job ? { ...job, cancel: undefined } : null);
const busy = () => !!job && !["done", "failed", "cancelled"].includes(job.status);
const renderState = () => ({ job: publicJob(), queue, waiting, renders: renders.slice(-6).reverse() });
const pump = () => {
  if (busy() || !queue.length) return broadcast("render", renderState());
  const m = readMemory();
  if (m?.pressure === "critical") {
    waiting = `Waiting for memory · ${m.freeMB.toLocaleString("en-US")} MB free`;
    broadcast("render", renderState());
    return setTimeout(pump, 3000);
  }
  waiting = null;
  const next = queue.shift();
  let finished = false;
  job = startRender({
    root: ROOT, composition: next.composition, totalFrames: next.durationInFrames,
    onUpdate: (j) => {
      broadcast("job", j);
      if (finished || !["done", "failed", "cancelled"].includes(j.status)) return;
      finished = true;
      renders.push({ id: j.id, composition: j.composition, out: j.out, status: j.status, frames: j.check?.frames ?? null, broken: j.check?.broken ?? null,
        sizeMB: j.sizeMB ?? null, minutes: ((j.finishedAt ?? Date.now()) - j.startedAt) / 60000, minFreeMB: j.minFreeMB, finishedAt: j.finishedAt });
      renders = renders.slice(-50);
      writeFileSync(RENDERS, JSON.stringify(renders, null, 1));
      setTimeout(pump, 400);
    },
  });
  broadcast("render", renderState());
};
const reveal = (file) => {
  if (process.platform === "darwin") spawn("open", ["-R", file], { stdio: "ignore" });
  else if (process.platform === "win32") spawn("explorer", [`/select,${file}`], { stdio: "ignore" });
  else spawn("xdg-open", [dirname(file)], { stdio: "ignore" });
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(INDEX);
    }
    if (p === "/__dailies/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": dailies\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (p.startsWith("/__dailies/build/")) {
      const f = inside(BUILD, p.slice("/__dailies/build/".length));
      return f ? sendFile(req, res, f) : json(res, 404, { error: "not built yet" });
    }
    if (p.startsWith("/__dailies/files/")) {
      const f = inside(DIR, p.slice("/__dailies/files/".length));
      return f ? sendFile(req, res, f) : json(res, 404, { error: "no such file" });
    }
    if (p === "/__dailies/api/state" && req.method === "GET") {
      return json(res, 200, { version: VERSION, project: { name: project.name, root: ROOT }, notes: loadNotes(ROOT), job: publicJob(), render: renderState(), memory: readMemory() });
    }
    if (p === "/__dailies/api/notes" && req.method === "GET") return json(res, 200, loadNotes(ROOT));
    if (p === "/__dailies/api/notes" && req.method === "POST") {
      const b = await body(req);
      const notes = loadNotes(ROOT);
      const id = nextId(notes);
      const image = `notes/n${String(id).padStart(3, "0")}.png`;
      await capture({ composition: b.composition, frame: b.frame, clean: false, file: join(DIR, image) });
      const note = {
        id, composition: b.composition, frame: b.frame, fps: b.fps, text: String(b.text ?? "").trim(),
        shape: b.shape ?? null, image, status: "open", reply: null, created: new Date().toISOString(), fixed: null,
      };
      saveNotes(ROOT, [...notes, note]);
      return json(res, 200, note);
    }
    const one = p.match(/^\/__dailies\/api\/notes\/(\d+)$/);
    if (one && req.method === "PATCH") {
      const b = await body(req);
      const notes = loadNotes(ROOT).map((n) =>
        n.id === Number(one[1]) ? { ...n, ...(b.text !== undefined ? { text: b.text } : {}), ...(b.status ? { status: b.status, fixed: b.status === "fixed" ? new Date().toISOString() : null } : {}) } : n);
      saveNotes(ROOT, notes);
      return json(res, 200, notes.find((n) => n.id === Number(one[1])) ?? null);
    }
    if (one && req.method === "DELETE") {
      const id = Number(one[1]);
      const note = loadNotes(ROOT).find((n) => n.id === id);
      saveNotes(ROOT, loadNotes(ROOT).filter((n) => n.id !== id));
      if (note?.image) rmSync(join(DIR, note.image), { force: true });
      return json(res, 200, { ok: true });
    }
    if (p === "/__dailies/api/capture" && req.method === "POST") {
      const b = await body(req);
      const file = join(DIR, "frames", `${b.composition}-${b.frame}.png`);
      await capture({ composition: b.composition, frame: b.frame, clean: true, file });
      return json(res, 200, { image: file });
    }
    if (p === "/__dailies/api/render" && req.method === "GET") return json(res, 200, renderState());
    if (p === "/__dailies/api/render" && req.method === "POST") {
      const b = await body(req);
      if (!b.composition) return json(res, 400, { error: "Which composition?" });
      queue.push({ composition: b.composition, durationInFrames: b.durationInFrames ?? null, added: Date.now() });
      pump();
      return json(res, 200, renderState());
    }
    if (p === "/__dailies/api/render/cancel" && req.method === "POST") {
      job?.cancel?.();
      return json(res, 200, { ok: true });
    }
    const q = p.match(/^\/__dailies\/api\/render\/queue\/(\d+)$/);
    if (q && req.method === "DELETE") {
      queue.splice(Number(q[1]), 1);
      broadcast("render", renderState());
      return json(res, 200, renderState());
    }
    if (p === "/__dailies/api/reveal" && req.method === "POST") {
      const b = await body(req);
      const f = inside(ROOT, String(b.out ?? ""));
      if (!f || !existsSync(f)) return json(res, 404, { error: "That file is gone." });
      reveal(f);
      return json(res, 200, { ok: true });
    }
    if (p === "/__dailies/api/cleanup" && req.method === "GET") {
      const items = findLeftovers(DIR);
      return json(res, 200, { bytes: items.reduce((a, i) => a + i.bytes, 0), count: items.length });
    }
    if (p === "/__dailies/api/cleanup" && req.method === "POST") {
      if (busy() || remotionRunning()) return json(res, 409, { error: "A render is running. Clean up when it's done." });
      const freed = removeLeftovers(findLeftovers(DIR));
      return json(res, 200, { freed });
    }
    if (p === "/__dailies/api/memory") return json(res, 200, readMemory());
    if (p === "/__dailies/api/activity" && req.method === "POST") {
      const b = await body(req);
      broadcast("activity", { text: String(b.text ?? "").slice(0, 120), at: Date.now() });
      return json(res, 200, { ok: true });
    }
    // everything else: the project's public folder, so staticFile() works exactly like in the Studio
    const f = inside(PUBLIC, p.slice(1));
    if (f) return sendFile(req, res, f);
    return json(res, 404, { error: `not found: ${p}` });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e.message });
  }
});

// notes changed on disk (the MCP server marks them fixed): tell the window
let notesTimer = null;
watch(DIR, (_ev, name) => {
  if (name !== "notes.json") return;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => broadcast("notes", loadNotes(ROOT)), 80);
});

await new Promise((res, rej) => {
  server.once("error", (e) => rej(e.code === "EADDRINUSE" ? new Error(`port ${PORT} is busy (is Dailies already running?). Try --port ${PORT + 10}`) : e));
  server.listen(PORT, "127.0.0.1", res);
}).catch((e) => fail(e.message));
await ctx.watch();
writeFileSync(join(DIR, "server.json"), JSON.stringify({ port: PORT, devtoolsPort: DEVTOOLS_PORT, pid: process.pid, root: ROOT, started: new Date().toISOString() }, null, 2));
console.log(`Dailies ${VERSION} · ${project.name}\n  film code: ${ENTRY}\n  app:       http://localhost:${PORT}\n  notes:     ${join(DIR, "notes.json")}`);

let chromeProc = null;
const shutdown = async () => {
  rmSync(join(DIR, "server.json"), { force: true });
  try {
    chromeProc?.kill();
  } catch {
    /* already closed */
  }
  await ctx.dispose().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (!flag("no-window")) {
  const chrome = findChrome(ROOT);
  if (!chrome) {
    console.log(`Google Chrome not found. Open http://localhost:${PORT} yourself (notes need the Dailies window for frame pictures: set DAILIES_CHROME).`);
  } else {
    chromeProc = spawn(chrome, [
      `--app=http://localhost:${PORT}/`, `--remote-debugging-port=${DEVTOOLS_PORT}`, `--user-data-dir=${join(DIR, "chrome-profile")}`,
      "--no-first-run", "--no-default-browser-check", `--window-size=${opt("window", "1600,1000")}`, `--window-position=${opt("window-position", "0,30")}`,
      "--lang=en-US", "--autoplay-policy=no-user-gesture-required",
      "--disable-features=Translate,MediaRouter", "--disable-background-timer-throttling",
    ], { stdio: "ignore" });
    chromeProc.on("exit", () => {
      console.log("Dailies window closed.");
      shutdown();
    });
  }
}
