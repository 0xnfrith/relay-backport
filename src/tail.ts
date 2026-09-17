// `relay-backport tail` — a `tail -F` for the file sink: print the lines the
// harness appends, keep following across truncation, rotation and a file
// that does not exist yet. Polling rather than fs.watch, so Linux, macOS and
// Windows behave the same. Nothing but the file's own lines reaches stdout.
//
// A tail keeps a persistent LINE CURSOR (default `<state dir>/tail.cursor`):
// the number of lines it has already handed to its consumer. A tail that
// restarts therefore REPLAYS the lines written while it was down instead of
// silently skipping them — the delivery file is a queue, and a supervisor
// restart is not a reason to drop mentions. `--no-cursor` restores the old
// follow-from-the-end behaviour.
import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MENTION_PREFIX = "MENTION|";

/**
 * `tail --no-thread`: drop `thread_context` / `thread_truncated` from a
 * MENTION line, for a human watching the wire — the field is the session's
 * whole history and can be thousands of characters per line.
 *
 * A line that is not a MENTION line, or whose JSON does not parse, is returned
 * VERBATIM: the tail is a queue reader, and a line it cannot understand is
 * still a line its consumer must see. Filtering happens in the write path
 * only, never by skipping a line — the cursor counts lines consumed.
 */
export function stripThreadContext(line: string): string {
  if (!line.startsWith(MENTION_PREFIX)) return line;
  const json = line.slice(MENTION_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return line;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return line;
  const obj = parsed as Record<string, unknown>;
  if (!("thread_context" in obj) && !("thread_truncated" in obj)) return line;
  delete obj.thread_context;
  delete obj.thread_truncated;
  return MENTION_PREFIX + JSON.stringify(obj);
}

export type TailOptions = {
  path: string;
  write: (line: string) => void;
  /**
   * Lines from the end of the file to print before following (default 0: only
   * what arrives from now on). Cursorless tailing only — with a cursor, the
   * cursor decides where the tail starts.
   */
  lines?: number;
  follow?: boolean;
  pollMs?: number;
  signal?: AbortSignal;
  /**
   * Persist the number of lines already delivered here, and start from it.
   * Undefined turns the cursor off (`--no-cursor`).
   */
  cursorPath?: string;
};

/** The `EVENT|` line a cursored tail prints when it finds a gap to replay. */
export function catchupLine(n: number): string {
  return `EVENT|catchup|${n} line(s) written while the tail was down`;
}

function readRangeBuf(path: string, start: number, end: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function readRange(path: string, start: number, end: number): string {
  return readRangeBuf(path, start, end).toString("utf8");
}

function stat(path: string): { size: number; ino: number } | undefined {
  try {
    const s = statSync(path);
    return { size: s.size, ino: Number(s.ino) };
  } catch {
    return undefined;
  }
}

/** The last `n` complete lines of a text, in order. */
export function lastLines(text: string, n: number): string[] {
  if (n <= 0) return [];
  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  return all.slice(-n);
}

/**
 * The BYTE offset just past each complete line of a buffer. `ends.length` is
 * the complete-line count; `ends[n - 1]` is where line n + 1 begins. Byte
 * offsets, not string indices, because the tail seeks by byte.
 */
export function lineEnds(buf: Buffer): number[] {
  const ends: number[] = [];
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) ends.push(i + 1);
  return ends;
}

/**
 * The cursor's value: a bare decimal line count. Anything unreadable,
 * missing or malformed reads as 0 — a cursor that cannot be trusted replays
 * from the top rather than skipping lines.
 */
export function readCursor(path: string, readFile: (p: string) => string = (p) => readRange(p, 0, statSync(p).size)): number {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    return 0;
  }
  const digits = text.replace(/[^0-9]/g, "");
  if (digits === "") return 0;
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Write the cursor atomically: a temp file in the same directory, then a
 * rename. A crash mid-write therefore leaves the previous value, never a
 * truncated one that would replay the whole file.
 */
export function writeCursor(path: string, n: number): void {
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${n}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    // A cursor that cannot be written is not worth killing the tail for: the
    // lines still reach the consumer, only the restart guarantee is lost.
  }
}

export async function tailFile(opts: TailOptions): Promise<void> {
  const pollMs = opts.pollMs ?? 200;
  const follow = opts.follow ?? true;
  const cursorPath = opts.cursorPath;
  let offset = 0;
  let ino = -1;
  let partial = "";
  let lineNo = 0;
  /** The file vanished under us; re-place ourselves against the cursor when it returns. */
  let resyncNeeded = false;

  const emit = (line: string) => {
    opts.write(line);
    if (cursorPath) {
      // Advance per line CONSUMED, not per line printed: should a future tail
      // ever filter its output, a cursor that only counted printed lines
      // would replay the filtered ones forever.
      lineNo++;
      writeCursor(cursorPath, lineNo);
    }
  };

  const drain = (size: number) => {
    if (size <= offset) return;
    partial += readRange(opts.path, offset, size);
    offset = size;
    let nl = partial.indexOf("\n");
    while (nl >= 0) {
      emit(partial.slice(0, nl));
      partial = partial.slice(nl + 1);
      nl = partial.indexOf("\n");
    }
  };

  /**
   * Place the tail against the persisted cursor and replay whatever the file
   * has beyond it. Used at start AND whenever the file has been away: `stat`
   * fails for a transient EACCES or a filesystem hiccup as readily as for a
   * delete, so a file that vanishes and comes back unchanged must NOT replay —
   * only a file that is genuinely shorter than the cursor claims does.
   */
  const resyncFromCursor = (size: number) => {
    let start = readCursor(cursorPath!);
    const ends = lineEnds(readRangeBuf(opts.path, 0, size));
    if (ends.length < start) start = 0; // rotated or truncated while we were away
    lineNo = start;
    offset = start === 0 ? 0 : ends[start - 1]!;
    partial = "";
    if (ends.length > start) {
      opts.write(catchupLine(ends.length - start));
      drain(size);
    }
  };

  /** A confirmed rotation or truncation of a file we are watching: it starts over, and so does the cursor. */
  const rewind = () => {
    offset = 0;
    partial = "";
    lineNo = 0;
    if (cursorPath) writeCursor(cursorPath, 0);
  };

  const initial = stat(opts.path);
  if (initial) ino = initial.ino;

  if (cursorPath) {
    if (initial) resyncFromCursor(initial.size);
    else resyncNeeded = true;
  } else if (initial) {
    offset = initial.size;
    const wanted = opts.lines ?? 0;
    if (wanted > 0) for (const l of lastLines(readRange(opts.path, 0, initial.size), wanted)) opts.write(l);
  }
  if (!follow) return;

  while (!opts.signal?.aborted) {
    const s = stat(opts.path);
    if (!s) {
      // missing, not yet created, or briefly unreadable: forget where we were.
      // The cursor on disk is deliberately left alone.
      offset = 0;
      partial = "";
      lineNo = 0;
      ino = -1;
      resyncNeeded = true;
    } else if (resyncNeeded) {
      ino = s.ino;
      resyncNeeded = false;
      if (cursorPath) resyncFromCursor(s.size);
      else drain(s.size);
    } else {
      if (s.ino !== ino || s.size < offset) {
        // rotated (new inode) or truncated under a live tail: the file starts over
        rewind();
        ino = s.ino;
      }
      drain(s.size);
    }
    await new Promise<void>((r) => {
      const t = setTimeout(r, pollMs);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        r();
      }, { once: true });
    });
  }
}
