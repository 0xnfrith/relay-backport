// `relay-backport tail` — a `tail -F` for the file sink: print the lines the
// harness appends, keep following across truncation, rotation and a file
// that does not exist yet. Polling rather than fs.watch, so Linux, macOS and
// Windows behave the same. Nothing but the file's own lines reaches stdout.
import { closeSync, openSync, readSync, statSync } from "node:fs";

export type TailOptions = {
  path: string;
  write: (line: string) => void;
  /** Lines from the end of the file to print before following (default 0: only what arrives from now on). */
  lines?: number;
  follow?: boolean;
  pollMs?: number;
  signal?: AbortSignal;
};

function readRange(path: string, start: number, end: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(end - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
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

export async function tailFile(opts: TailOptions): Promise<void> {
  const pollMs = opts.pollMs ?? 200;
  const follow = opts.follow ?? true;
  let offset = 0;
  let ino = -1;
  let partial = "";

  const initial = stat(opts.path);
  if (initial) {
    ino = initial.ino;
    offset = initial.size;
    const wanted = opts.lines ?? 0;
    if (wanted > 0) for (const l of lastLines(readRange(opts.path, 0, initial.size), wanted)) opts.write(l);
  }
  if (!follow) return;

  while (!opts.signal?.aborted) {
    const s = stat(opts.path);
    if (!s) {
      // deleted or not yet created: start from the top when it appears
      offset = 0;
      ino = -1;
      partial = "";
    } else {
      if (s.ino !== ino || s.size < offset) {
        // rotated (new inode) or truncated: the file starts over
        offset = 0;
        ino = s.ino;
        partial = "";
      }
      if (s.size > offset) {
        partial += readRange(opts.path, offset, s.size);
        offset = s.size;
        let nl = partial.indexOf("\n");
        while (nl >= 0) {
          opts.write(partial.slice(0, nl));
          partial = partial.slice(nl + 1);
          nl = partial.indexOf("\n");
        }
      }
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
