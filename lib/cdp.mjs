// A minimal Chrome DevTools Protocol client (no dependencies): enough to evaluate in the Dailies window
// and take exact screenshots of the frame the user is looking at.
import { createRequire } from "node:module";
import { join } from "node:path";

const getWebSocket = (root) => {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  // Node 20: borrow `ws` from the Remotion project (the Remotion CLI depends on it)
  return createRequire(join(root, "package.json"))("ws");
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const connectToPage = async ({ root, port, urlPrefix, timeoutMs = 20000 }) => {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (!target && Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page" && t.url.startsWith(urlPrefix)) ?? null;
    } catch {
      /* Chrome is still starting */
    }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error(`Could not find the Dailies window on DevTools port ${port}`);
  const WS = getWebSocket(root);
  const ws = new WS(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error(`DevTools connection failed: ${e?.message ?? e}`));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
};
