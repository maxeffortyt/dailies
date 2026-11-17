# Dailies

**Review your Remotion film straight from code, frame by frame. Circle what's wrong; Claude gets the note. No render.**

Dailies opens a window next to your Remotion project. It plays every composition live from your code, so you can stop on the exact frame, draw a circle around what's wrong and write a note. Claude Code reads your notes through the Dailies tools: it sees the frame with your circle, fixes the code, looks at the same frame again (still no render), and marks the note fixed. When everything is fixed, you render once, and Dailies checks every frame of the result for broken ones.

Made for the maxeffort YouTube channel. Free and open source (MIT). Runs on macOS and Windows.

## What it does
- **Live preview, no render.** Every `<Composition>` in your project plays in `@remotion/player`, straight from your code. Change the code and the window reloads on the same frame.
- **Frame by frame.** `Space` plays and pauses, `←` `→` step one frame, `Shift` + arrow steps ten.
- **Notes on the frame.** Press `N`, drag a circle around the problem, type what's wrong, press `Enter`. Each note keeps the composition, the frame, the time and a picture of the frame with your circle.
- **Send to Claude.** One button copies a short message. Paste it into Claude Code.
- **Claude tools (MCP).** Claude reads the notes and looks at the circled frames, then checks any frame of the live preview after a fix. It marks notes fixed with a one-line reply, and the note turns green in the window.
- **Before / after.** Open a fixed note and drag the divider: the frame as you circled it on the left, the fixed frame live on the right.
- **Render once, check every frame.** The Render button runs the real Remotion CLI on one thread. While it runs, you see progress and free memory. When it's done, every frame of the video is compared with its neighbours, so a black flash or a corrupted frame is caught.
- **Render queue.** Press Render on several compositions: they render one at a time. If your computer is critically short on memory, the next render waits until there's room.
- **Finished renders.** Each render is listed with its frame check, size and time; `Show` opens it in Finder or Explorer.
- **Clean up.** Remotion leaves temporary bundles behind when a render is stopped or crashes. Dailies shows how much space they take and deletes them with one click (never while a render is running).

## Requirements
- macOS or Windows 10/11
- Google Chrome or Microsoft Edge (found automatically; or set `DAILIES_CHROME` to the browser's path)
- Node.js 20.19+ and a Remotion v4 project with its packages installed (`npm install`)
- Claude Code (the desktop app or the CLI)

Dailies installs no packages. It uses the ones your Remotion project already has: `esbuild`, `react`, `remotion` and `@remotion/player`. If `@remotion/player` is missing, run `npx remotion add @remotion/player`.

## Install
The easy way: open your Remotion project in Claude Code and say:

> Install Dailies in this project: https://github.com/maxeffortyt/dailies

Or by hand:

```bash
git clone https://github.com/maxeffortyt/dailies ~/dailies
```

Then, in your Remotion project folder:

```bash
claude mcp add dailies --scope project -- node ~/dailies/bin/mcp.mjs --project "$PWD"
```

```bash
node ~/dailies/bin/dailies.mjs
```

Restart your Claude Code session once, so it loads the Dailies tools.

### For Claude: installing Dailies in a Remotion project
1. Check that the folder is a Remotion project (`package.json` depends on `remotion`) and that `node_modules` exists.
2. Clone the repo somewhere permanent (for example `~/dailies`), or use the path the user gave you.
3. Add the MCP server to the project's `.mcp.json`. Merge it into the file if one exists; use absolute paths:
   `{"mcpServers": {"dailies": {"command": "node", "args": ["<dailies>/bin/mcp.mjs", "--project", "<project>"]}}}`
4. Allow the tools without prompts by adding `"enabledMcpjsonServers": ["dailies"]` and `"permissions": {"allow": ["mcp__dailies"]}` to `.claude/settings.json`.
5. Start the window in the background from the project folder: `node <dailies>/bin/dailies.mjs`.
6. Tell the user to restart the Claude session once so the `dailies_*` tools load. Then they press `N` on any frame to leave a note.

## Tools Claude gets
| Tool | What it does |
|---|---|
| `dailies_notes` | Lists notes: frame, time, text, where the circle is, status |
| `dailies_note` | One note with the picture of the frame and the circle |
| `dailies_frame` | A picture of any frame from the live preview (checks a fix without rendering) |
| `dailies_note_update` | Marks a note fixed (or open) with a one-line reply |
| `dailies_render` | Renders the video once on one thread, then checks every frame |
| `dailies_render_status` | Render progress, free memory and the frame check result |

## Where things are
- `.dailies/notes.json` and `.dailies/notes/*.png` in your project: your notes and their pictures. The folder ignores itself in git.
- `out/<composition>.mp4`: renders.
- Options: `--port 4545`, `--project <path>`, `--no-window`, `--window 1600,1000`.

## Good to know
- The preview runs your real code in the browser. A browser isn't a render, so fonts, `<OffthreadVideo>` (played as a normal video) and timing of very heavy scenes can differ slightly from the final file. That's why there's one real render at the end, and it checks every frame.
- Your compositions are found by running your `Root` once. Compositions created in effects or by custom bundler plugins may not show up.
- Films with many sounds at once: the player keeps a pool of 48 audio tags (Remotion's default is 5).
- On macOS the memory panel also shows swap; on Windows it shows free memory.

If you find a bug: leave a note. Open an issue.
