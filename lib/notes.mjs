// Notes live next to the film: <project>/.dailies/notes.json, frame images in <project>/.dailies/notes/.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const dailiesDir = (root) => {
  const dir = join(root, ".dailies");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    // keeps the folder out of git without touching the project's own .gitignore
    writeFileSync(join(dir, ".gitignore"), "*\n");
  }
  for (const sub of ["notes", "frames", "build"]) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
};

export const notesPath = (root) => join(dailiesDir(root), "notes.json");

export const loadNotes = (root) => {
  const p = notesPath(root);
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(data.notes) ? data.notes : [];
  } catch {
    return [];
  }
};

export const saveNotes = (root, notes) => {
  const p = notesPath(root);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, notes }, null, 2));
  renameSync(tmp, p); // atomic: the app and the MCP server never read half a file
};

export const nextId = (notes) => notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;

export const timecode = (frame, fps) => {
  const s = frame / fps;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
};

export const describeShape = (shape) => {
  if (!shape) return "no mark";
  const r = (v) => Math.round(v);
  if (shape.type === "ellipse") {
    return `circled area x ${r(shape.cx - shape.rx)}–${r(shape.cx + shape.rx)}, y ${r(shape.cy - shape.ry)}–${r(shape.cy + shape.ry)} (composition pixels)`;
  }
  return "marked area";
};

export const noteLine = (n) =>
  `#${n.id} · ${n.composition} · frame ${n.frame.toLocaleString("en-US")} (${timecode(n.frame, n.fps)}) · ${n.status}` +
  `\n   "${n.text}"\n   ${describeShape(n.shape)}` +
  (n.reply ? `\n   reply: ${n.reply}` : "");
