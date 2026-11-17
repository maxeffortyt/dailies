// Finds the Remotion project Dailies runs in and the packages it already has.
// Dailies installs nothing: esbuild, React, remotion and @remotion/player come from the project's own node_modules.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, basename } from "node:path";

export const findProject = (start) => {
  let dir = resolve(start);
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.remotion || deps["@remotion/cli"]) return { root: dir, pkg, name: pkg.name && pkg.name !== "remotion-blank" ? pkg.name : basename(dir) };
      } catch {
        /* unreadable package.json: keep looking */
      }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
};

const configText = (root) => {
  for (const f of ["remotion.config.ts", "remotion.config.js", "remotion.config.mjs"]) {
    const p = join(root, f);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return "";
};

const configString = (root, method) => {
  const m = configText(root).match(new RegExp(`Config\\.${method}\\(\\s*["'\`]([^"'\`]+)["'\`]`));
  return m ? m[1] : null;
};

export const findEntry = (root) => {
  const fromConfig = configString(root, "setEntryPoint");
  const candidates = [
    fromConfig,
    "src/index.ts", "src/index.tsx", "src/index.js", "src/index.jsx",
    "remotion/index.ts", "remotion/index.tsx", "remotion/index.js",
    "app/remotion/index.ts", "src/remotion/index.ts", "src/remotion/index.tsx",
  ].filter(Boolean);
  for (const c of candidates) {
    const p = resolve(root, c);
    if (existsSync(p)) return p;
  }
  return null;
};

export const findPublicDir = (root) => resolve(root, configString(root, "setPublicDir") ?? "public");

export const findChrome = (root) => {
  const pf = process.env.PROGRAMFILES ?? "C:\\Program Files", pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", lad = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    process.env.DAILIES_CHROME,
    configString(root, "setBrowserExecutable"),
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    // Windows
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    lad && join(lad, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    // Linux
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
};

// require.resolve from the project folder, so every package exists exactly once (one React, one remotion).
export const projectRequire = (root) => createRequire(join(root, "package.json"));

export const resolveFromProject = (root, spec) => {
  try {
    return projectRequire(root).resolve(spec);
  } catch {
    return null;
  }
};
