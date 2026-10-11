# AGENTS.md

Guidance for AI coding agents working in this repo. Read `README.md` first for what the project is and how its parts fit together; this file covers the rules and the non-obvious things that are easy to break.

## Ground rules

These protect the owner's keys, privacy and money. Follow them without exception.

- **Never commit or print secrets.** `.env` holds live keys (`ASSEMBLYAI_API_KEY`, `OPENROUTER_API_KEY`, `EXA_API_KEY`). It is git-ignored; keep it that way. When checking whether a key is set, report presence or length, never the value.
- **`logs/` is private.** Debug logs contain full transcripts of real conversations between real people. Never commit them, and don't quote them anywhere outside this machine. They are fine to read locally for debugging.
- **Commits:** only when asked, and push only when asked. Never add a `Co-Authored-By` trailer or any other AI attribution to commit messages or PR descriptions. Before committing, check that nothing from `.env`, `logs/`, `dist/` or scratch work is staged.
- **Live model calls cost real money** (OpenRouter, Exa, AssemblyAI). Prefer free paths: mock mode (`INGEST=mock`, `--board=mock`), offline tests against the real code, or a fake OpenRouter server pointed at with `OPENROUTER_BASE_URL`. When a live test is justified, cap it (stop the server after a few runs) and report what it cost; current spend is at `GET https://openrouter.ai/api/v1/key`.
  - Never leave `INGEST=mock` running with `BOARD=agent`. The mock conversation loops every 40 seconds, so the agent keeps paying for updates indefinitely.
- **Don't disturb the owner's running instance.** They often have `npm run dev` running on ports 8787 (server) and 5173 (Vite). Check with `lsof -nP -iTCP -sTCP:LISTEN` and test on other ports instead: `PORT=8798 npx tsx server/index.ts` plus `PORT=8798 npx vite --port 5199 --strictPort`. `tsx watch` hot-reloads your server edits into their instance, so expect it to restart as you work.
- **Don't make sound in the room** (`say`, audio playback) while a live instance is transcribing; it ends up in their transcript.
- **Clean up after yourself.** Remove scratch scripts, test logs you created, and test processes (servers, headless browsers) before you finish. Never leave test files in the repo.

## Commands

```bash
npm run dev                          # server (tsx watch) + Vite, http://localhost:5173
npm run dev -- --speakers=3 --board=mock   # flags are forwarded to the server
npm run typecheck                    # tsc --noEmit, strict
npm run build                        # production client build into dist/
npm run start                        # production: serves dist/ and the live feed on :8787
npx tsx scripts/analyze-log.mts logs/<file>.jsonl   # replay a debug log through the segmenter
```

There is no test suite. Verify with typecheck, build, and a running instance (see [Verifying changes](#verifying-changes)).

## Stack and version constraints

- **Node 20.12** on the owner's machine. Vite 7+ needs a newer Node, so **Vite is pinned to 5 and `@vitejs/plugin-react` to 4.7.0**. Don't upgrade either without upgrading Node first.
- **shadcn CLI needs Node ≥ 20.18.1.** Run it with a newer Node from nvm, only for generating components:
  `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npx -y shadcn@4.21.4 add <component> -y`. Components land in `src/components/ui/` and import `cn` from shadcn's own `cn` package (via `src/lib/utils.ts`); that dependency is intentional.
- React 19, Tailwind v4 (gradient utilities are `bg-linear-to-*`), Zod v4, TypeScript strict with `noUnusedLocals`, `noUnusedParameters` and `verbatimModuleSyntax` (type-only imports must use `import type`).
- The `dev` script uses `sh -c '… $*' --` so that `npm run dev -- --flag` reaches the server through `concurrently`. Keep that shape if you edit it.

## Where things live

```
server/index.ts        startup; reads env, applies CLI flags (server/args.ts), wires everything
server/ingest/         mic capture (PvRecorder) → AssemblyAI → segmenter → bus; spectrum; mock adapter
server/bus.ts          the live feed: broadcasts events, replays a snapshot to new screens
server/board/          the board agent: board state + rules, tools, OpenRouter client, prompt, Exa, Wikipedia, mock board
src/shared/            the contract between server and screens: events.ts, board.ts (tile catalog)
src/client/            React app: App (tabs), store (bus → state), components/, ambient (p5 visual)
```

`src/shared/` is the single source of truth for every shape that crosses the wire. Don't redefine those types elsewhere. The client imports them with `import type`, which keeps Zod out of the browser bundle.

## Invariants

Things that look safe to change but aren't, mostly learned the hard way.

### Audio and transcription

- **The microphone is captured on the server**, never in the browser. On macOS, mic permission belongs to the app running the server (Terminal, Cursor…). A server that hears only silence almost always means that app lacks permission; the browser is irrelevant.
- **Device selection is by name, not index.** A device whose name contains "usb" (`AUDIO_DEVICE_MATCH`) wins over the system default, because indices shift whenever hardware is plugged in or out. `AUDIO_DEVICE_INDEX` is only an explicit override.
- **The segmenter must never drop words.** AssemblyAI labels unresolved words `PENDING`/`UNKNOWN`; they fold into the current line or a neutral `UNKNOWN` line and adopt the real speaker when it arrives. Dropping them once made the whole board appear dead.
- **Audio events run at ~16 Hz.** They bypass React state (`store.onAudio`) and go straight to the canvas. Don't route them through `useAppState`.
- `vite.config.ts` replaces Vite's WebSocket proxy error handling to tear down dead sockets quietly (otherwise: EPIPE stacks and phantom clients). Keep it.

### The board agent

Each run is one fresh, self-contained request; the board itself is the agent's memory. Two rhythms: `update` (Sonnet, on new speech) and `reorganize` (Opus, every `BOARD_EDITOR_INTERVAL_S` while the board is changing). A failed editor pass must never back off or block updates.

Guardrails the server enforces. Keep them in the server, not in the prompt alone:

- **The model never supplies image URLs.** Images come from a Wikipedia article it names (`wikipedia`) or a search result it references (`imageFrom`); the server resolves them.
- **Sources must be real.** With Exa, a cited URL must be one a search or Wikipedia lookup actually returned this session (normalized comparison). Without Exa, the link must resolve.
- **Speakers** in a tile must exist in the transcript; never `UNKNOWN`.
- **Limits:** at most 12 tiles, one `featured` tile (featuring another demotes the first), at most 3 web searches per run, 10 model round-trips per run.
- **Identical rewrites are refused** (`Board.put` returns `"unchanged"`) so tiles don't flash for nothing.
- **Fatal OpenRouter errors** (401/402/403) stop the agent and show the reason on the board.
- **Board order:** the featured tile first, then newest first; a replaced tile keeps its slot.
- **Positions keep each speaker's stance history server-side** (`PublishedStance.history`), so shifts show even if the model doesn't mention them.

### Prompt caching

The request is laid out so each run reads almost everything from cache. Breaking this silently multiplies cost.

- `SYSTEM_PROMPT` (`server/board/prompt.ts`) is frozen text at the head of the cached prefix. Edit it deliberately; every edit costs one full cache rewrite. Never put anything volatile in it (timestamps, counts, board state).
- **Transcript chunks are append-only and byte-identical once rendered,** one chunk per run, with the cache marker on the newest. Never re-render, reorder or trim earlier chunks.
- Anything that changes every run (the board brief, task instructions) goes **after** the last cache marker.
- Caches are per model, so the updater and the editor each keep their own.

### OpenRouter client (`server/board/openrouter.ts`)

- Plain `fetch`, on purpose: the fields this needs (`reasoning`, Anthropic `cache_control`, `reasoning_details`, server tools) aren't in the OpenAI SDK's types. Don't swap in an SDK or another provider without being asked; the owner chose OpenRouter.
- **Pass `reasoning_details` back exactly as received** on assistant messages within a run.
- Usage reports web searches under `usage.server_tool_use_details` (OpenRouter's docs say `server_tool_use`; the live API differs).
- OpenRouter sends `200` headers before the model has finished, so a dropped connection surfaces while reading the body. That is treated as transient and retried. A sleeping machine causes exactly this; run long live tests under `caffeinate -i`.
- Model slugs: `anthropic/claude-sonnet-5.5` (updates) and `anthropic/claude-opus-5.5` (editor).

## Common changes

**Add or change a tile kind**

1. Edit the Zod schema in `tileInputSchemas` (`src/shared/board.ts`). Every kind keeps an optional `prominence`. Length limits are enforced by Zod when the tool call is validated, so keep text short enough for a wall screen.
2. The `put_<kind>` tool is generated from the schema; add its description in `PUT_DESCRIPTIONS` (`server/board/tools.ts`).
3. Render it: add a case to `TileBody` and an entry in `KIND` (`src/client/components/tiles.tsx`), handling all three sizes (`featured`, `normal`, `minor`).
4. Mention it in `SYSTEM_PROMPT` if the agent needs guidance, and add an example to the mock board (`server/board/mock.ts`) so it can be checked without spending money.

**Add a setting**: read it from `process.env` where it's used (that's the pattern), document it in `.env.example` and the README's configuration table. CLI flags are parsed in `server/args.ts` and copied into `process.env` at startup, so they override `.env`.

**Change agent behavior**: prefer server-side rules over prompt instructions when the behavior is a guarantee. When changing the prompt or instructions, re-check the caching rules above.

## Verifying changes

1. `npm run typecheck` and `npm run build`.
2. Run an isolated instance on test ports (see Ground rules) in mock mode: `INGEST=mock BOARD=mock PORT=8798 npx tsx server/index.ts`.
3. Look at it. Playwright's Chromium is cached at `~/Library/Caches/ms-playwright/chromium-1080/chrome-mac/Chromium.app`; drive it headless over the DevTools protocol, wait in real time (the page needs its WebSocket and animation loop), and screenshot `http://localhost:5199/?view=board` and `/`. The page collects runtime errors in `window.__pageErrors`; an empty array means it ran clean.
4. For agent logic, prefer exercising `ToolExecutor` and `Board` directly in a throwaway `tsx` script, or a fake OpenRouter server that checks request shape. Only then, if needed, a short capped live run with `DEBUG_LOG_FILE` set.
5. Stop every process you started and delete scratch files.

## Debug logs

With `DEBUG_LOG_FILE` set, the server appends JSONL to that file across sessions; each process starts with a `session_start` record. Useful events:

- **Transcription:** `aai_turn`, segmenter `word` / `commit`, `mic_level`.
- **Agent:** records with `scope: "board"`: `response` (usage and cost), `tool` (arguments and result), `run` (summary note), `run_error`.

## Known limitations

- **Speaker numbers can shift on a reload.** Screens number speakers in first-seen order, and the server's snapshot only replays the last 200 lines, so reloading late in a long session can renumber speakers. The fix is server-owned speaker identity (planned alongside speaker names).
- **Minor tiles still take a full grid cell;** a masonry layout is a planned improvement.
- **Live stance shifts are unproven.** They work offline and in mock mode, but in a live replay the update model didn't revisit a debate when a speaker softened. Watch for it before tuning the update instructions.
