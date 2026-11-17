#!/usr/bin/env node
// Dailies MCP server (stdio): lets Claude Code read your notes, see the circled frames,
// look at any frame of the live preview, mark notes fixed and start a safe render.
// Register it in your Remotion project:
//   claude mcp add dailies -- node /path/to/dailies/bin/mcp.mjs --project /path/to/your/remotion/project
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { findProject } from "../lib/project.mjs";
import { dailiesDir, loadNotes, noteLine, saveNotes } from "../lib/notes.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const args = process.argv.slice(2);
const i = args.indexOf("--project");
const project = findProject(i >= 0 ? args[i + 1] : process.env.DAILIES_PROJECT ?? process.cwd());
const ROOT = project?.root ?? null;
const log = (...m) => process.stderr.write(`[dailies-mcp] ${m.join(" ")}\n`);

const INSTRUCTIONS = `Dailies holds review notes for this Remotion film. A note is a frame number, the user's words and a picture of that frame with the area they circled.
Work through notes like this: dailies_notes to list them, dailies_note to see a note's picture, fix the code, dailies_frame to look at the same frame in the live preview (it reloads by itself when code changes), then dailies_note_update with status "fixed" and a one-line reply saying what you changed.
Do not render the whole film to check a fix; dailies_frame shows it without rendering. When every note is fixed, dailies_render makes the final video once and checks every frame.`;

const TOOLS = [
  {
    name: "dailies_notes",
    description: "List the review notes the user left in Dailies (frame, time, text, where they circled, status).",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "fixed", "all"], description: "Which notes to list. Default: open." } } },
  },
  {
    name: "dailies_note",
    description: "Show one note: its text and the picture of the frame with the area the user circled.",
    inputSchema: { type: "object", properties: { id: { type: "number", description: "Note number, e.g. 3" } }, required: ["id"] },
  },
  {
    name: "dailies_frame",
    description: "Picture of any frame of a composition straight from the live preview (no render). Use it to check a fix. Needs the Dailies window to be open.",
    inputSchema: {
      type: "object",
      properties: { composition: { type: "string", description: "Composition id" }, frame: { type: "number", description: "Frame number (0-based)" } },
      required: ["composition", "frame"],
    },
  },
  {
    name: "dailies_note_update",
    description: "Mark a note fixed (or open again) and leave a one-line reply the user sees on the note.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, status: { type: "string", enum: ["fixed", "open"] }, reply: { type: "string", description: "What you changed, in one line" } },
      required: ["id", "status"],
    },
  },
  {
    name: "dailies_render",
    description: "Render the final video once with safe settings (1 thread), then check every frame for broken ones. Needs the Dailies window to be open.",
    inputSchema: { type: "object", properties: { composition: { type: "string" } }, required: ["composition"] },
  },
  {
    name: "dailies_render_status",
    description: "Progress of the current render, free memory, and the result of the frame check.",
    inputSchema: { type: "object", properties: {} },
  },
];

const text = (t) => ({ type: "text", text: t });
const image = (file) => ({ type: "image", data: readFileSync(file).toString("base64"), mimeType: "image/png" });

const app = async () => {
  const f = join(dailiesDir(ROOT), "server.json");
  if (!existsSync(f)) return null;
  const { port } = JSON.parse(readFileSync(f, "utf8"));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__dailies/api/memory`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? `http://127.0.0.1:${port}` : null;
  } catch {
    return null;
  }
};
// lets the Dailies window show what Claude is doing (fire and forget)
const activity = async (text) => {
  try {
    const base = await app();
    if (base) await fetch(`${base}/__dailies/api/activity`, { method: "POST", body: JSON.stringify({ text }), signal: AbortSignal.timeout(1500) });
  } catch {
    /* window closed: nothing to show */
  }
};
const NOT_RUNNING = "The Dailies window isn't open. Ask the user to start it in the project folder: node <path-to-dailies>/bin/dailies.mjs";

const fmtJob = (j) => {
  if (!j) return "No render has been started in this Dailies session.";
  const mem = j.memory ? ` · RAM free ${j.memory.freeMB} MB${j.memory.swapUsedGB !== null ? `, swap ${j.memory.swapUsedGB.toFixed(1)} GB` : ""}` : "";
  if (j.status === "done") {
    const b = j.check?.broken ?? [];
    const mins = ((j.finishedAt - j.startedAt) / 60000).toFixed(1);
    return `Done: ${j.out} (${j.sizeMB?.toFixed(1)} MB) in ${mins} min.\nFrame check: ${b.length === 0 ? `0 broken frames in ${j.check.frames}` : `${b.length} broken frame(s): ${b.join(", ")}`}.`;
  }
  if (j.status === "failed") return `Render failed: ${j.error}`;
  if (j.status === "cancelled") return `Render of ${j.composition} was cancelled.`;
  if (j.status === "checking") return `Checking frames: ${j.checked ?? 0}/${j.total ?? "?"}${mem}`;
  return `${j.status}: ${j.rendered}/${j.total ?? "?"} frames${j.eta ? `, ${j.eta} left` : ""}${mem}`;
};

const call = async (name, a = {}) => {
  if (!ROOT) return { content: [text("No Remotion project found. Start the server with --project <path> or from inside the project.")], isError: true };
  const notes = loadNotes(ROOT);
  switch (name) {
    case "dailies_notes": {
      const st = a.status ?? "open";
      const list = st === "all" ? notes : notes.filter((n) => n.status === st);
      await activity(`Claude read the notes (${notes.filter((n) => n.status === "open").length} open)`);
      if (!list.length) return { content: [text(st === "open" ? "No open notes. Everything the user marked is fixed." : "No notes.")] };
      return { content: [text(`${list.length} ${st === "all" ? "" : `${st} `}note(s):\n\n${list.map(noteLine).join("\n\n")}\n\nUse dailies_note with an id to see the frame.`)] };
    }
    case "dailies_note": {
      const n = notes.find((x) => x.id === Number(a.id));
      if (!n) return { content: [text(`No note #${a.id}.`)], isError: true };
      await activity(`Claude is looking at note #${n.id}`);
      const file = join(ROOT, ".dailies", n.image);
      return { content: [text(noteLine(n)), ...(existsSync(file) ? [image(file)] : [text("(picture missing)")])] };
    }
    case "dailies_frame": {
      const base = await app();
      if (!base) return { content: [text(NOT_RUNNING)], isError: true };
      const r = await fetch(`${base}/__dailies/api/capture`, { method: "POST", body: JSON.stringify({ composition: a.composition, frame: Number(a.frame) }) });
      const j = await r.json();
      if (!r.ok) return { content: [text(`Couldn't capture: ${j.error}`)], isError: true };
      await activity(`Claude checked frame ${Number(a.frame).toLocaleString("en-US")}`);
      return { content: [text(`${a.composition} · frame ${Number(a.frame).toLocaleString("en-US")} (live preview)`), image(j.image)] };
    }
    case "dailies_note_update": {
      const id = Number(a.id);
      if (!notes.some((n) => n.id === id)) return { content: [text(`No note #${id}.`)], isError: true };
      const updated = notes.map((n) => (n.id === id ? { ...n, status: a.status, reply: a.reply ?? n.reply, fixed: a.status === "fixed" ? new Date().toISOString() : null } : n));
      saveNotes(ROOT, updated);
      await activity(`Claude marked #${id} ${a.status}`);
      const left = updated.filter((n) => n.status === "open").length;
      return { content: [text(`Note #${id} is ${a.status}. ${left} open note(s) left.`)] };
    }
    case "dailies_render": {
      const base = await app();
      if (!base) return { content: [text(NOT_RUNNING)], isError: true };
      const r = await fetch(`${base}/__dailies/api/render`, { method: "POST", body: JSON.stringify({ composition: a.composition }) });
      const st = await r.json();
      if (!r.ok) return { content: [text(st.error ?? "Couldn't start the render.")], isError: true };
      await activity(`Claude queued a render of ${a.composition}`);
      const now = st.job && st.job.composition === a.composition && !["done", "failed", "cancelled"].includes(st.job.status);
      return { content: [text(now ? `Render started: ${st.job.composition} → ${st.job.out} (1 thread). Check progress with dailies_render_status.`
        : `Queued: ${a.composition} (${st.queue.length} waiting${st.waiting ? `; ${st.waiting}` : ""}). Dailies renders one at a time. Check progress with dailies_render_status.`)] };
    }
    case "dailies_render_status": {
      const base = await app();
      if (!base) return { content: [text(NOT_RUNNING)], isError: true };
      const st = await (await fetch(`${base}/__dailies/api/render`)).json();
      const more = st.queue?.length ? `\nQueued next: ${st.queue.map((x) => x.composition).join(", ")}${st.waiting ? ` (${st.waiting})` : ""}` : "";
      return { content: [text(fmtJob(st.job) + more)] };
    }
    default:
      return { content: [text(`Unknown tool ${name}`)], isError: true };
  }
};

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled...)
  try {
    if (method === "initialize") {
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dailies", version: VERSION },
        instructions: INSTRUCTIONS,
      } });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") return send({ jsonrpc: "2.0", id, result: await call(params?.name, params?.arguments) });
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    log(e.stack ?? e.message);
    return send({ jsonrpc: "2.0", id, result: { content: [text(`Dailies error: ${e.message}`)], isError: true } });
  }
});
log(`ready · v${VERSION} · project ${ROOT ?? "(none)"}`);
