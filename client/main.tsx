// The Dailies window: your film playing live from code, frame by frame, with notes you draw on the frame.
import "./style.css";
import "dailies:project-entry"; // the film's own entry point; it calls registerRoot (recorded by the shim)
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Player, type PlayerRef } from "@remotion/player";
import { CollectorContext, type Registered } from "./remotion-shim";

type Shape = { type: "ellipse"; cx: number; cy: number; rx: number; ry: number };
type Note = {
  id: number; composition: string; frame: number; fps: number; text: string; shape: Shape | null; image: string;
  status: "open" | "fixed"; reply: string | null; created: string; fixed: string | null;
};
type Meta = { durationInFrames: number; fps: number; width: number; height: number; props: Record<string, unknown> };
type Mem = { totalGB: number; freeMB: number; usedGB: number; swapUsedGB: number | null; pressure?: "normal" | "warning" | "critical" } | null;
type Job = {
  status: string; composition: string; out: string; rendered: number; total: number | null; eta: string | null; startedAt: number;
  finishedAt: number | null; memory: Mem; minFreeMB: number | null; maxSwapGB: number | null; check: { frames: number; broken: number[] } | null;
  error: string | null; sizeMB?: number; checked?: number; id?: number;
};
type Done = { id: number; composition: string; out: string; status: string; frames: number | null; broken: number[] | null; sizeMB: number | null; minutes: number };
type RenderState = { job: Job | null; queue: { composition: string }[]; waiting: string | null; renders: Done[] };
const fmtMB = (b: number) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1048576))} MB`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
const fmtN = (n: number) => n.toLocaleString("en-US");
const tc = (frame: number, fps: number) => {
  const s = frame / fps;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
};
const VIEW_KEY = "dailies:view";
const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(`/__dailies/api/${path}`, { ...init, headers: { "Content-Type": "application/json" } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
};
const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (ok: () => boolean, timeout: number) => {
  const t0 = performance.now();
  while (!ok() && performance.now() - t0 < timeout) await sleep(30);
};

// Render the film's Root once (hidden), with the shim collecting every <Composition>.
let collectError: string | null = null;
const collect = async (): Promise<Registered[]> => {
  const Root = g.__dailiesRoot as React.FC | undefined;
  if (!Root) return [];
  const list: Registered[] = [];
  const el = document.createElement("div");
  el.style.display = "none";
  document.body.appendChild(el);
  const keep = (e: unknown) => {
    collectError = (e as Error)?.stack ?? String(e);
  };
  const root = createRoot(el, { onUncaughtError: keep, onCaughtError: keep, onRecoverableError: keep });
  root.render(
    <CollectorContext.Provider value={{ add: (c) => { if (!list.some((x) => x.id === c.id)) list.push(c); } }}>
      <Root />
    </CollectorContext.Provider>,
  );
  for (let i = 0; i < 40 && !list.length && !collectError; i++) await sleep(25);
  await sleep(60);
  root.unmount();
  el.remove();
  return list;
};

const resolveMeta = async (c: Registered): Promise<Meta> => {
  let meta: Meta = { durationInFrames: c.durationInFrames ?? 1, fps: c.fps ?? 30, width: c.width ?? 1920, height: c.height ?? 1080, props: c.defaultProps ?? {} };
  if (c.calculateMetadata) {
    const r = (await c.calculateMetadata({ defaultProps: meta.props, props: meta.props, abortSignal: new AbortController().signal, compositionId: c.id, isRendering: false })) ?? {};
    meta = { ...meta, ...(r as Partial<Meta>), props: ((r as { props?: Record<string, unknown> }).props ?? meta.props) };
  }
  return meta;
};

export const Logo: React.FC<{ size?: number }> = ({ size = 30 }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" aria-label="Dailies">
    <rect x="4" y="4" width="92" height="92" rx="24" fill="#FFC83D" />
    <rect x="22" y="30" width="56" height="40" rx="7" fill="#0D1021" />
    {[0, 1, 2, 3].map((i) => <rect key={i} x={27 + i * 13} y={34} width={6} height={5} rx={1.5} fill="#FFC83D" />)}
    {[0, 1, 2, 3].map((i) => <rect key={`b${i}`} x={27 + i * 13} y={61} width={6} height={5} rx={1.5} fill="#FFC83D" />)}
    <circle cx="66" cy="50" r="7" fill="#FF5D5D" />
  </svg>
);

const App: React.FC<{ comps: Registered[] }> = ({ comps }) => {
  const saved = useMemo(() => {
    try {
      return JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "null") as { compId: string; frame: number } | null;
    } catch {
      return null;
    }
  }, []);
  const [compId, setCompId] = useState<string>(() =>
    saved && comps.some((c) => c.id === saved.compId) ? saved.compId : (comps.find((c) => !c.still)?.id ?? comps[0]?.id ?? ""));
  const comp = comps.find((c) => c.id === compId) ?? null;
  const [meta, setMeta] = useState<Meta | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [rq, setRq] = useState<RenderState>({ job: null, queue: [], waiting: null, renders: [] });
  const [tmp, setTmp] = useState<{ bytes: number; count: number } | null>(null);
  const [mem, setMem] = useState<Mem>(null);
  const [projectName, setProjectName] = useState("");
  const [drawMode, setDrawMode] = useState(false);
  const [draft, setDraft] = useState<{ shape: Shape; text: string; saving: boolean } | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [capturing, setCapturing] = useState<null | { clean: boolean }>(null);
  const [error, setError] = useState<string | null>(null);
  const [box, setBox] = useState({ w: 960, h: 540 });
  const [scrubbing, setScrubbing] = useState(false);
  const [acts, setActs] = useState<{ text: string; at: number }[]>([]);
  const [compare, setCompare] = useState<number | null>(null); // before/after on a fixed note
  const [split, setSplit] = useState(0.5);
  const playerRef = useRef<PlayerRef>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const restoreFrame = useRef<number | null>(saved && saved.compId === compId ? saved.frame : null);
  const live = useRef({ compId, meta, frame });
  live.current = { compId, meta, frame };

  const showToast = useCallback((t: string) => {
    setToast(t);
    window.clearTimeout(g.__dailiesToastTimer);
    g.__dailiesToastTimer = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // composition metadata (calculateMetadata runs here, like in the Studio)
  useEffect(() => {
    setMeta(null);
    if (!comp) return;
    let alive = true;
    resolveMeta(comp).then((m) => alive && setMeta(m)).catch((e) => setError(`calculateMetadata() of ${comp.id} failed:\n${e.stack ?? e.message}`));
    return () => {
      alive = false;
    };
  }, [comp]);

  // fit the film into the stage
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !meta) return;
    const fit = () => {
      const aw = el.clientWidth - 44, ah = el.clientHeight - 44;
      const s = Math.min(aw / meta.width, ah / meta.height);
      setBox({ w: Math.max(160, Math.floor(meta.width * s)), h: Math.max(90, Math.floor(meta.height * s)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [meta]);

  // player events
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !meta) return;
    const onFrame = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener("frameupdate", onFrame);
    p.addEventListener("seeked", onFrame);
    p.addEventListener("play", onPlay);
    p.addEventListener("pause", onPause);
    p.addEventListener("ended", onPause);
    if (restoreFrame.current !== null) {
      setFrame(Math.min(restoreFrame.current, meta.durationInFrames - 1));
      restoreFrame.current = null;
    }
    return () => {
      p.removeEventListener("frameupdate", onFrame);
      p.removeEventListener("seeked", onFrame);
      p.removeEventListener("play", onPlay);
      p.removeEventListener("pause", onPause);
      p.removeEventListener("ended", onPause);
    };
  }, [meta, compId]);

  // data: notes, render job, memory; live updates from the Dailies server
  useEffect(() => {
    api("state").then((s) => {
      setNotes(s.notes);
      setJob(s.job);
      if (s.render) setRq(s.render);
      setMem(s.memory);
      setProjectName(s.project.name);
      document.title = `Dailies · ${s.project.name}`;
    });
    const es: EventSource | undefined = g.__dailiesEvents;
    const onNotes = (e: MessageEvent) => setNotes(JSON.parse(e.data));
    const onJob = (e: MessageEvent) => setJob(JSON.parse(e.data));
    const onRender = (e: MessageEvent) => {
      const st = JSON.parse(e.data) as RenderState;
      setRq(st);
      if (st.job) setJob(st.job);
      api("cleanup").then(setTmp).catch(() => {});
    };
    api("cleanup").then(setTmp).catch(() => {});
    const onAct = (e: MessageEvent) => setActs((a) => [...a.slice(-3), JSON.parse(e.data)]);
    es?.addEventListener("notes", onNotes);
    es?.addEventListener("job", onJob);
    es?.addEventListener("render", onRender);
    es?.addEventListener("activity", onAct);
    g.__dailiesShowError = (t: string) => setError(t);
    const t = window.setInterval(() => api("memory").then(setMem).catch(() => {}), 4000);
    return () => {
      es?.removeEventListener("notes", onNotes);
      es?.removeEventListener("job", onJob);
      es?.removeEventListener("render", onRender);
      es?.removeEventListener("activity", onAct);
      window.clearInterval(t);
    };
  }, []);

  // when the code changes, the page reloads on the same composition and frame
  g.__dailiesBeforeReload = () =>
    sessionStorage.setItem(VIEW_KEY, JSON.stringify({ compId: live.current.compId, frame: playerRef.current?.getCurrentFrame() ?? live.current.frame }));

  const seek = useCallback((f: number) => {
    const p = playerRef.current, m = live.current.meta;
    if (!p || !m) return;
    const c = Math.max(0, Math.min(m.durationInFrames - 1, Math.round(f)));
    p.seekTo(c);
    setFrame(c);
  }, []);
  const step = useCallback((d: number) => {
    playerRef.current?.pause();
    seek((playerRef.current?.getCurrentFrame() ?? live.current.frame) + d);
  }, [seek]);

  // frame pictures for notes and for Claude: the server drives these through DevTools
  useEffect(() => {
    g.__dailies = {
      prepareCapture: async ({ composition, frame: f, clean }: { composition: string; frame: number; clean: boolean }) => {
        if (composition && composition !== live.current.compId) {
          setCompId(composition);
          await waitFor(() => live.current.compId === composition && !!live.current.meta && !!playerRef.current, 10000);
          await sleep(300);
        }
        const p = playerRef.current!;
        p.pause();
        const target = Math.max(0, Math.min((live.current.meta?.durationInFrames ?? 1) - 1, f));
        p.seekTo(target);
        setFrame(target);
        await waitFor(() => p.getCurrentFrame() === target, 3000);
        flushSync(() => setCapturing({ clean }));
        await document.fonts.ready;
        const t0 = performance.now();
        while (performance.now() - t0 < 6000) {
          const root = stageRef.current!;
          const imgs = Array.from(root.querySelectorAll("img"));
          const vids = Array.from(root.querySelectorAll("video"));
          if (imgs.every((i) => i.complete) && vids.every((v) => v.readyState >= 2 && !v.seeking)) break;
          await sleep(40);
        }
        await raf();
        await raf();
        await raf();
        const r = stageRef.current!.getBoundingClientRect();
        if (clean) window.setTimeout(() => showToast(`Claude looked at frame ${fmtN(target)}`), 50);
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      },
      finishCapture: () => setCapturing(null),
    };
  });

  // keyboard: space, arrows (shift = 10 frames), N to circle something, Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        playerRef.current?.toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(e.shiftKey ? -10 : -1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(e.shiftKey ? 10 : 1);
      } else if (e.key === "Home") seek(0);
      else if (e.key === "End") seek(Infinity);
      else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        playerRef.current?.pause();
        setDraft(null);
        setDrawMode(true);
      } else if (e.key === "Escape") {
        setCompare(null);
        setDrawMode(false);
        setDraft(null);
        setDragStart(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seek, step]);

  // drawing a circle on the frame
  const toComp = (e: React.PointerEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * meta!.width) / r.width, y: ((e.clientY - r.top) * meta!.height) / r.height };
  };
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drawMode || !meta) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toComp(e);
    setDragStart(p);
    setDraft({ shape: { type: "ellipse", cx: p.x, cy: p.y, rx: 0, ry: 0 }, text: "", saving: false });
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragStart) return;
    const p = toComp(e);
    setDraft((d) => d && { ...d, shape: { type: "ellipse", cx: (dragStart.x + p.x) / 2, cy: (dragStart.y + p.y) / 2, rx: Math.abs(p.x - dragStart.x) / 2, ry: Math.abs(p.y - dragStart.y) / 2 } });
  };
  const onUp = () => {
    if (!dragStart || !meta) return;
    setDraft((d) => {
      if (!d) return d;
      if (d.shape.rx < 12 && d.shape.ry < 12) return { ...d, shape: { type: "ellipse", cx: dragStart.x, cy: dragStart.y, rx: meta.width * 0.06, ry: meta.width * 0.06 } };
      return d;
    });
    setDragStart(null);
    setDrawMode(false);
  };

  const saveNote = async () => {
    if (!draft || !meta || draft.saving) return;
    const text = draft.text.trim();
    if (!text) return;
    setDraft({ ...draft, saving: true });
    try {
      const f = playerRef.current?.getCurrentFrame() ?? frame;
      const n: Note = await api("notes", { method: "POST", body: JSON.stringify({ composition: compId, frame: f, fps: meta.fps, text, shape: draft.shape }) });
      setDraft(null);
      setSelected(n.id);
      setNotes(await api("notes"));
      showToast(`Note #${n.id} saved · frame ${fmtN(n.frame)}`);
    } catch (e) {
      setDraft((d) => d && { ...d, saving: false });
      showToast(`Couldn't save the note: ${(e as Error).message}`);
    }
  };

  const open = notes.filter((n) => n.status === "open");
  const compareNote = notes.find((n) => n.id === compare && n.composition === compId && n.frame === frame) ?? null;
  const sendToClaude = async () => {
    const where = [...new Set(open.map((n) => n.composition))].join(", ");
    const msg = `I left ${open.length} note${open.length === 1 ? "" : "s"} in Dailies (${where}). Use the dailies tools: dailies_notes to list them and dailies_note to see each circled frame. Fix the code, check the same frame with dailies_frame (no render), then mark each note fixed with dailies_note_update.`;
    try {
      await navigator.clipboard.writeText(msg);
      showToast("✓ Copied. Paste it into Claude.");
    } catch {
      showToast("The browser blocked copying. Click the window once and try again.");
    }
  };

  const startRender = async () => {
    if (!meta) return;
    try {
      const st = (await api("render", { method: "POST", body: JSON.stringify({ composition: compId, durationInFrames: meta.durationInFrames }) })) as RenderState;
      setRq(st);
      if (st.job) setJob(st.job);
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const scale = meta ? box.w / meta.width : 1;
  const here = notes.filter((n) => n.composition === compId && n.frame === frame && n.shape);
  const showShapes = !capturing;
  const popLeft = draft && meta ? ((draft.shape.cx + draft.shape.rx) * scale + 356 < box.w ? (draft.shape.cx + draft.shape.rx) * scale + 16 : Math.max(10, (draft.shape.cx - draft.shape.rx) * scale - 356)) : 0;
  const popTop = draft && meta ? Math.min(Math.max(10, (draft.shape.cy - draft.shape.ry) * scale), box.h - 170) : 0;
  const pct = meta ? (frame / Math.max(1, meta.durationInFrames - 1)) * 100 : 0;
  const frameAt = (clientX: number) => {
    const r = timelineRef.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * ((meta?.durationInFrames ?? 1) - 1);
  };
  const running = job && !["done", "failed", "cancelled"].includes(job.status);
  const cleanUp = async () => {
    try {
      const r = await api("cleanup", { method: "POST" });
      showToast(`Cleaned up ${fmtMB(r.freed)}`);
    } catch (e) {
      showToast((e as Error).message);
    }
    api("cleanup").then(setTmp).catch(() => {});
  };
  const older = rq.renders.filter((r) => r.id !== job?.id).slice(0, 2);
  const memNow = running ? job?.memory : mem;

  if (!comps.length) {
    return (
      <div className="error">
        <h2>No compositions found</h2>
        Dailies loaded your entry point, but it didn&apos;t register a root with &lt;Composition&gt; elements.
        {collectError ? `\n\n${collectError}` : null}
      </div>
    );
  }

  return (
    <div className={`app${capturing ? " capturing" : ""}`}>
      <div className="top">
        <div className="brand"><Logo size={30} />Dailies</div>
        <span className="project">{projectName}</span>
        <select className="comp-select" value={compId} onChange={(e) => { setCompId(e.target.value); setFrame(0); setDraft(null); }}>
          {comps.map((c) => <option key={c.id} value={c.id}>{c.folder ? `${c.folder}/` : ""}{c.id}</option>)}
        </select>
        <div className="spacer" />
        <span className="hint">
          <span className="kbd">Space</span> play · <span className="kbd">←</span> <span className="kbd">→</span> frame · <span className="kbd">N</span> circle something
        </span>
      </div>
      <div className="body">
        <div className="left">
          <div className="stage-wrap" ref={wrapRef}>
            {comp && meta ? (
              <div className="stage" ref={stageRef} style={{ width: box.w, height: box.h }}>
                <Player
                  ref={playerRef}
                  key={compId}
                  {...(comp.lazyComponent ? { lazyComponent: comp.lazyComponent } : { component: comp.component! })}
                  inputProps={meta.props}
                  durationInFrames={meta.durationInFrames}
                  compositionWidth={meta.width}
                  compositionHeight={meta.height}
                  fps={meta.fps}
                  initialFrame={Math.min(restoreFrame.current ?? 0, meta.durationInFrames - 1)}
                  style={{ width: box.w, height: box.h }}
                  controls={false}
                  clickToPlay={false}
                  doubleClickToFullscreen={false}
                  spaceKeyToPlayOrPause={false}
                  numberOfSharedAudioTags={48}
                  acknowledgeRemotionLicense
                  errorFallback={({ error: err }) => (
                    <div style={{ color: "#FF5D5D", padding: 24, fontFamily: "SF Mono, monospace", fontSize: 14, whiteSpace: "pre-wrap" }}>{err.message}</div>
                  )}
                />
                <svg className={`overlay${drawMode ? " drawing" : ""}`} viewBox={`0 0 ${meta.width} ${meta.height}`} preserveAspectRatio="none"
                  onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} style={{ pointerEvents: drawMode || dragStart ? "auto" : "none" }}>
                  {showShapes && here.map((n) => (
                    <g key={n.id} opacity={selected === null || selected === n.id ? 1 : 0.55}>
                      <ellipse cx={n.shape!.cx} cy={n.shape!.cy} rx={n.shape!.rx} ry={n.shape!.ry} fill="none" stroke={n.status === "fixed" ? "#3DDC97" : "#FFC83D"}
                        strokeWidth={4 / scale} strokeDasharray={n.status === "fixed" ? `${14 / scale} ${10 / scale}` : undefined} />
                      <text x={n.shape!.cx + n.shape!.rx * 0.71} y={n.shape!.cy - n.shape!.ry * 0.71 - 8 / scale} fill={n.status === "fixed" ? "#3DDC97" : "#FFC83D"}
                        fontFamily="SF Mono, Menlo, monospace" fontWeight={700} fontSize={22 / scale}>#{n.id}</text>
                    </g>
                  ))}
                  {draft && (!capturing || !capturing.clean) ? (
                    <ellipse cx={draft.shape.cx} cy={draft.shape.cy} rx={draft.shape.rx} ry={draft.shape.ry} fill="rgba(255,200,61,0.08)" stroke="#FFC83D" strokeWidth={5 / scale} />
                  ) : null}
                </svg>
                {compareNote && !capturing ? (
                  <div className="compare"
                    onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const r = e.currentTarget.getBoundingClientRect(); setSplit(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))); }}
                    onPointerMove={(e) => { if (e.buttons !== 1) return; const r = e.currentTarget.getBoundingClientRect(); setSplit(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))); }}>
                    <img src={`/__dailies/files/${compareNote.image}`} alt="" style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }} />
                    <div className="divider" style={{ left: `${split * 100}%` }}><div className="handle">⟷</div></div>
                    <div className="tag before">before</div>
                    <div className="tag after">after</div>
                  </div>
                ) : null}
                {drawMode ? <div className="draw-hint">Drag around what&apos;s wrong · Esc to cancel</div> : null}
                {draft && !dragStart && !drawMode ? (
                  <div className="popover" style={{ left: popLeft, top: popTop }}>
                    <div className="label">note · frame {fmtN(frame)} · {tc(frame, meta.fps)}</div>
                    <textarea autoFocus placeholder="What's wrong here?" value={draft.text} disabled={draft.saving}
                      onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveNote(); }
                        if (e.key === "Escape") setDraft(null);
                      }} />
                    <div className="row">
                      <button className="btn ghost small" onClick={() => setDraft(null)}>Cancel</button>
                      <button className="btn yellow small" disabled={!draft.text.trim() || draft.saving} onClick={saveNote}>{draft.saving ? "Saving…" : "Save note"}</button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="small">Loading {compId}…</div>
            )}
          </div>
          <div className="transport">
            <div className="controls">
              <button className="icon-btn" title="Start (Home)" onClick={() => seek(0)}>⏮</button>
              <button className="icon-btn" title="Previous frame (←)" onClick={() => step(-1)}>◀</button>
              <button className="icon-btn play" title="Play / pause (Space)" onClick={() => playerRef.current?.toggle()}>{playing ? "❚❚" : "▶"}</button>
              <button className="icon-btn" title="Next frame (→)" onClick={() => step(1)}>▶</button>
              <button className="icon-btn" title="End (End)" onClick={() => seek(Infinity)}>⏭</button>
              <span className="frame-no">frame {fmtN(frame)}</span>
              <span className="frame-of">/ {fmtN(meta?.durationInFrames ?? 0)}</span>
              <div className="spacer" />
              <span className="tc">{meta ? `${tc(frame, meta.fps)} / ${tc(meta.durationInFrames, meta.fps)} · ${meta.fps} fps` : ""}</span>
              <button className="btn small" style={{ marginLeft: 12 }} onClick={() => { playerRef.current?.pause(); setDraft(null); setDrawMode(true); }}>◯ Circle something</button>
            </div>
            <div className="timeline" ref={timelineRef}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); playerRef.current?.pause(); setScrubbing(true); seek(frameAt(e.clientX)); }}
              onPointerMove={(e) => scrubbing && seek(frameAt(e.clientX))}
              onPointerUp={() => setScrubbing(false)}>
              <div className="track"><div className="fill" style={{ width: `${pct}%` }} /></div>
              {notes.filter((n) => n.composition === compId).map((n) => (
                <div key={n.id} className={`pin ${n.status}`} title={`#${n.id} ${n.text}`} style={{ left: `${(n.frame / Math.max(1, (meta?.durationInFrames ?? 1) - 1)) * 100}%` }} />
              ))}
              <div className="head" style={{ left: `${pct}%` }} />
            </div>
          </div>
        </div>
        <div className="side">
          <div className="side-head">
            <h2>Notes<span className="count">{open.length} open</span></h2>
            <button className="btn yellow" disabled={!open.length} onClick={sendToClaude}>Send to Claude</button>
          </div>
          <div>{acts.length ? (
            <div className="activity">
              {acts.map((a, i) => (
                <div key={`${a.at}-${i}`} className={`act${i === acts.length - 1 ? " last" : ""}`}>
                  <span className="dot" />
                  <span>{a.text}</span>
                  <span className="t">{new Date(a.at).toLocaleTimeString("en-GB")}</span>
                </div>
              ))}
            </div>
          ) : null}</div>
          <div className="notes">
            {notes.length === 0 ? (
              <div className="empty">
                Play your film, stop where something&apos;s off and press <span className="kbd">N</span>.<br />Circle it, say what&apos;s wrong.<br />No render needed.
              </div>
            ) : null}
            {[...notes].reverse().map((n) => (
              <div key={n.id} className={`card ${n.status}${selected === n.id ? " sel" : ""}`}
                onClick={() => { setSelected(n.id); if (n.composition !== compId) setCompId(n.composition); else { playerRef.current?.pause(); seek(n.frame); } }}>
                <img src={`/__dailies/files/${n.image}`} alt="" />
                <div className="meta"><b>#{n.id}</b> frame {fmtN(n.frame)} · {tc(n.frame, n.fps)}<span className={`chip ${n.status}`}>{n.status === "fixed" ? "fixed" : "open"}</span></div>
                <div className="text">{n.text}</div>
                {n.reply ? <div className="reply">Claude: {n.reply}</div> : null}
                {selected === n.id ? (
                  <div className="actions">
                    {n.status === "fixed" ? (
                      <>
                        <button className="btn small yellow" onClick={(e) => { e.stopPropagation(); playerRef.current?.pause(); seek(n.frame); setSplit(0.5); setCompare(compare === n.id ? null : n.id); }}>
                          {compare === n.id ? "Close before/after" : "Before / after"}</button>
                        <button className="btn small" onClick={(e) => { e.stopPropagation(); api(`notes/${n.id}`, { method: "PATCH", body: JSON.stringify({ status: "open" }) }); }}>Reopen</button>
                      </>
                    ) : (
                      <button className="btn small" onClick={(e) => { e.stopPropagation(); api(`notes/${n.id}`, { method: "PATCH", body: JSON.stringify({ status: "fixed" }) }); }}>Mark fixed</button>
                    )}
                    <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); api(`notes/${n.id}`, { method: "DELETE" }).then(() => api("notes").then(setNotes)); }}>Delete</button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <div className="render">
            <div className="render-row">
              <h3>Render once</h3>
              <button className="btn small" onClick={startRender}>{running ? `+ Queue ${compId}` : `Render ${compId}`}</button>
            </div>
            {job ? (
              <>
                {job.status === "done" ? (
                  <div style={{ marginTop: 10 }}>
                    <div className={job.check && job.check.broken.length === 0 ? "ok" : "bad"}>
                      {job.check && job.check.broken.length === 0 ? `✓ 0 broken frames in ${fmtN(job.check.frames)}` : `✗ ${job.check?.broken.length} broken frame(s): ${job.check?.broken.map(fmtN).join(", ")}`}
                    </div>
                    <div className="small mono">{job.out} · {job.sizeMB?.toFixed(1)} MB · {(((job.finishedAt ?? 0) - job.startedAt) / 60000).toFixed(1)} min</div>
                  </div>
                ) : job.status === "failed" ? (
                  <div className="bad small" style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>✗ {job.error}</div>
                ) : job.status === "cancelled" ? (
                  <div className="small" style={{ marginTop: 8 }}>Render of {job.composition} cancelled.</div>
                ) : (
                  <>
                    <div className="bar"><div style={{ width: `${job.status === "checking" ? 100 : job.total ? (job.rendered / job.total) * 100 : 2}%` }} /></div>
                    <div className="small mono job-line">
                      <span>{job.composition} · {job.status === "checking" ? `checking every frame… ${fmtN(job.checked ?? 0)}` : job.status === "bundling" ? "bundling…" : `${fmtN(job.rendered)} / ${fmtN(job.total ?? 0)}${job.eta ? ` · ${job.eta} left` : ""}`}</span>
                      <button className="link" onClick={() => api("render/cancel", { method: "POST" })}>Cancel</button>
                    </div>
                  </>
                )}
              </>
            ) : <div className="small" style={{ marginTop: 6 }}>1 thread, then every frame is checked for broken ones.</div>}
            {rq.waiting ? <div className="small warn">{rq.waiting}</div> : null}
            {rq.queue.length ? (
              <div className="queue">
                <span className="small">Next</span>
                {rq.queue.map((q, i) => (
                  <span key={i} className="qchip">{q.composition}<button onClick={() => api(`render/queue/${i}`, { method: "DELETE" })}>×</button></span>
                ))}
              </div>
            ) : null}
            {older.length ? (
              <div className="renders">
                {older.map((r) => (
                  <div key={r.id} className="rrow">
                    <span className={r.status === "done" && r.broken?.length === 0 ? "ok" : r.status === "cancelled" ? "" : "bad"}>{r.status === "done" ? (r.broken?.length === 0 ? "✓" : "✗") : r.status === "cancelled" ? "–" : "✗"}</span>
                    <span className="rname">{r.composition}</span>
                    <span className="small mono">{r.status === "done" ? `${r.broken?.length === 0 ? `0 broken in ${fmtN(r.frames ?? 0)}` : `${r.broken?.length} broken`} · ${r.sizeMB?.toFixed(1)} MB · ${r.minutes.toFixed(1)} min` : r.status}</span>
                    {r.status === "done" ? <button className="link" onClick={() => api("reveal", { method: "POST", body: JSON.stringify({ out: r.out }) }).catch((e) => showToast(e.message))}>Show</button> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {memNow ? (
              <div className="mem">
                <span className={memNow.freeMB < 300 ? "low" : ""}>RAM free {fmtN(memNow.freeMB)} MB</span>
                {memNow.swapUsedGB !== null ? <span>swap {memNow.swapUsedGB.toFixed(1)} GB</span> : null}
                <span>of {Math.round(memNow.totalGB)} GB</span>
                {memNow.pressure && memNow.pressure !== "normal" ? <span className="low">memory {memNow.pressure}</span> : null}
              </div>
            ) : null}
            {tmp && tmp.bytes > 0 ? (
              <div className="cleanup">
                <span className="small">Leftover temp files · {fmtMB(tmp.bytes)}</span>
                <button className="btn small ghost" disabled={!!running} onClick={cleanUp}>Clean up</button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
      {error ? (
        <div className="error" onClick={() => setError(null)}>
          <h2>Build error</h2>
          {error}
        </div>
      ) : null}
    </div>
  );
};

collect().then((comps) => createRoot(document.getElementById("root")!).render(<App comps={comps} />));
