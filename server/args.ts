/**
 * Launch-time overrides, so one installed copy can be relaunched for a different
 * room without editing `.env`:
 *
 *   npm run dev -- --speakers=3
 *   npm run start -- --speakers 3 --board=mock
 *
 * Flags beat `.env`; anything not passed falls back to it.
 */
export interface CliOptions {
  maxSpeakers?: number;
  board?: BoardMode;
}

export const BOARD_MODES = ["agent", "mock", "off"] as const;
export type BoardMode = (typeof BOARD_MODES)[number];

const SPEAKER_FLAGS = new Set(["--speakers", "--max-speakers"]);
const BOARD_FLAG = "--board";
const SUPPORTED = "--speakers=N, --board=agent|mock|off";
const MIN_SPEAKERS = 1;
const MAX_SPEAKERS = 10; // AssemblyAI's accepted range for max_speakers

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!SPEAKER_FLAGS.has(flag) && flag !== BOARD_FLAG) {
      if (arg.startsWith("--")) throw new Error(`unknown flag ${flag} (supported: ${SUPPORTED})`);
      continue;
    }
    // Both `--flag=value` and `--flag value`.
    const raw = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (flag === BOARD_FLAG) opts.board = parseBoardMode(raw, flag);
    else opts.maxSpeakers = parseSpeakers(raw, flag);
  }
  return opts;
}

export function parseBoardMode(raw: string | undefined, source: string): BoardMode {
  const mode = BOARD_MODES.find((m) => m === raw);
  if (!mode) throw new Error(`${source} must be one of ${BOARD_MODES.join(", ")}, got ${raw ?? "nothing"}`);
  return mode;
}

function parseSpeakers(raw: string | undefined, flag: string): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < MIN_SPEAKERS || n > MAX_SPEAKERS) {
    throw new Error(`${flag} needs a whole number ${MIN_SPEAKERS}-${MAX_SPEAKERS}, got ${raw ?? "nothing"}`);
  }
  return n;
}
