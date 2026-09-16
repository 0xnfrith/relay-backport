import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catchupLine, lastLines, lineEnds, readCursor, tailFile, writeCursor } from "../src/tail";
import { waitFor } from "./helpers/acp-client";
import { tmpDir } from "./helpers/tmp";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function follow(path: string, lines = 0) {
  const out: string[] = [];
  const ctl = new AbortController();
  const done = tailFile({ path, write: (l) => out.push(l), lines, pollMs: 20, signal: ctl.signal });
  cleanups.push(() => ctl.abort());
  return { out, stop: () => ctl.abort(), done };
}

describe("tail", () => {
  test("lastLines: the last N complete lines, ignoring a trailing newline", () => {
    expect(lastLines("a\nb\nc\n", 2)).toEqual(["b", "c"]);
    expect(lastLines("a\nb", 5)).toEqual(["a", "b"]);
    expect(lastLines("a\nb\n", 0)).toEqual([]);
  });

  test("follows appends line by line, only prints complete lines, and starts from the end by default", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    writeFileSync(path, "old-1\nold-2\n");
    const f = follow(path);
    await Bun.sleep(60);
    expect(f.out).toEqual([]);
    appendFileSync(path, "MENTION|{\"a\":1}\npart");
    await waitFor(() => f.out.length === 1, 2000, "first line");
    expect(f.out).toEqual(['MENTION|{"a":1}']);
    appendFileSync(path, "ial\nEVENT|acp|closed\n");
    await waitFor(() => f.out.length === 3, 2000, "remaining lines");
    expect(f.out.slice(1)).toEqual(["partial", "EVENT|acp|closed"]);
    f.stop();
    await f.done;
  });

  test("--lines replays the tail of the file before following", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    writeFileSync(path, "1\n2\n3\n");
    const f = follow(path, 2);
    await waitFor(() => f.out.length === 2, 2000, "replayed lines");
    expect(f.out).toEqual(["2", "3"]);
    appendFileSync(path, "4\n");
    await waitFor(() => f.out.length === 3, 2000, "new line");
    f.stop();
  });

  test("a file that does not exist yet is picked up when created; truncation and rotation restart from the top", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "later.jsonl");
    const f = follow(path);
    await Bun.sleep(50);
    writeFileSync(path, "born, with a long first line\n");
    await waitFor(() => f.out.length === 1, 2000, "line after creation");
    expect(f.out).toEqual(["born, with a long first line"]);
    // truncate (same inode, smaller size)
    writeFileSync(path, "fresh\n");
    await waitFor(() => f.out.length === 2, 2000, "line after truncation");
    expect(f.out[1]).toBe("fresh");
    // rotate: move the file away, a new one appears
    renameSync(path, path + ".1");
    await Bun.sleep(50);
    writeFileSync(path, "rotated\n");
    await waitFor(() => f.out.length === 3, 2000, "line after rotation");
    expect(f.out[2]).toBe("rotated");
    unlinkSync(path);
    await Bun.sleep(50);
    appendFileSync(path, "again\n");
    await waitFor(() => f.out.length === 4, 2000, "line after delete");
    expect(f.out[3]).toBe("again");
    f.stop();
  });

  test("no-follow prints the requested lines and returns", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    writeFileSync(path, "x\ny\n");
    const out: string[] = [];
    await tailFile({ path, write: (l) => out.push(l), lines: 10, follow: false });
    expect(out).toEqual(["x", "y"]);
    const none: string[] = [];
    await tailFile({ path: join(t.dir, "missing"), write: (l) => none.push(l), lines: 10, follow: false });
    expect(none).toEqual([]);
  });
});

describe("tail cursor", () => {
  function followCursor(path: string, cursorPath: string) {
    const out: string[] = [];
    const ctl = new AbortController();
    const done = tailFile({ path, write: (l) => out.push(l), cursorPath, pollMs: 20, signal: ctl.signal });
    cleanups.push(() => ctl.abort());
    return { out, stop: () => ctl.abort(), done };
  }

  const cursorValue = (p: string) => readFileSync(p, "utf8");

  test("lineEnds counts complete lines and gives the byte offset each one ends at", () => {
    expect(lineEnds(Buffer.from(""))).toEqual([]);
    expect(lineEnds(Buffer.from("a\nbb\n"))).toEqual([2, 5]);
    expect(lineEnds(Buffer.from("a\npartial"))).toEqual([2]);
    // multi-byte: the offsets are BYTES, not string indices
    expect(lineEnds(Buffer.from("é\n"))).toEqual([3]);
  });

  test("readCursor tolerates a missing, empty or malformed cursor by reading 0", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    expect(readCursor(join(t.dir, "nope"))).toBe(0);
    const p = join(t.dir, "c");
    writeFileSync(p, "");
    expect(readCursor(p)).toBe(0);
    writeFileSync(p, "not a number\n");
    expect(readCursor(p)).toBe(0);
    writeFileSync(p, " 42 \n");
    expect(readCursor(p)).toBe(42);
  });

  test("writeCursor writes a bare line count atomically and leaves no temp file", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const p = join(t.dir, "tail.cursor");
    writeCursor(p, 7);
    expect(readFileSync(p, "utf8")).toBe("7\n");
    expect(() => readFileSync(p + ".tmp", "utf8")).toThrow();
    writeCursor(p, 8);
    expect(readCursor(p)).toBe(8);
  });

  test("cold start (no cursor file): every line already in the file is replayed, and the cursor lands on the count", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const cur = join(t.dir, "tail.cursor");
    writeFileSync(path, "MENTION|1\nMENTION|2\nMENTION|3\n");
    const f = followCursor(path, cur);
    await waitFor(() => f.out.length === 4, 2000, "catchup + replay");
    expect(f.out[0]).toBe(catchupLine(3));
    expect(f.out.slice(1)).toEqual(["MENTION|1", "MENTION|2", "MENTION|3"]);
    await waitFor(() => cursorValue(cur) === "3\n", 2000, "cursor at 3");
    f.stop();
    await f.done;
  });

  test("gap replay: a restart replays only the lines written while the tail was down", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const cur = join(t.dir, "tail.cursor");
    writeFileSync(path, "a\nb\n");
    const first = followCursor(path, cur);
    await waitFor(() => first.out.length === 3, 2000, "first run");
    first.stop();
    await first.done;
    expect(readCursor(cur)).toBe(2);

    // the tail is down; two more lines arrive
    appendFileSync(path, "c\nd\n");
    const second = followCursor(path, cur);
    await waitFor(() => second.out.length === 3, 2000, "second run");
    expect(second.out[0]).toBe(catchupLine(2));
    expect(second.out.slice(1)).toEqual(["c", "d"]);
    await waitFor(() => readCursor(cur) === 4, 2000, "cursor at 4");
    second.stop();
    await second.done;

    // a third run with no gap prints no catchup line at all
    const third = followCursor(path, cur);
    await Bun.sleep(80);
    expect(third.out).toEqual([]);
    third.stop();
    await third.done;
  });

  test("rotation: a file with fewer lines than the cursor claims replays from the top", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const cur = join(t.dir, "tail.cursor");
    writeFileSync(path, "1\n2\n3\n4\n");
    writeCursor(cur, 4);
    // rotated away; a fresh, shorter file takes its place
    writeFileSync(path, "fresh-1\n");
    const f = followCursor(path, cur);
    await waitFor(() => f.out.length === 2, 2000, "replay from the top");
    expect(f.out[0]).toBe(catchupLine(1));
    expect(f.out[1]).toBe("fresh-1");
    await waitFor(() => readCursor(cur) === 1, 2000, "cursor reset to 1");
    f.stop();
    await f.done;
  });

  test("the cursor advances line by line as new lines arrive, and rewinds to 0 on a live truncation", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const cur = join(t.dir, "tail.cursor");
    writeFileSync(path, "one\n");
    const f = followCursor(path, cur);
    await waitFor(() => readCursor(cur) === 1, 2000, "cursor at 1");
    appendFileSync(path, "two\n");
    await waitFor(() => readCursor(cur) === 2, 2000, "cursor at 2");
    appendFileSync(path, "three\n");
    await waitFor(() => readCursor(cur) === 3, 2000, "cursor at 3");
    // truncate under the live tail: same inode, smaller size
    writeFileSync(path, "restarted\n");
    await waitFor(() => f.out.includes("restarted"), 2000, "line after truncation");
    await waitFor(() => readCursor(cur) === 1, 2000, "cursor back to 1");
    f.stop();
    await f.done;
  });

  test("a file that vanishes and comes back UNCHANGED replays nothing; one that comes back shorter replays", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const cur = join(t.dir, "tail.cursor");
    const three = "1\n2\n3\n";
    writeFileSync(path, three);
    const f = followCursor(path, cur);
    await waitFor(() => readCursor(cur) === 3, 2000, "cursor at 3");
    expect(f.out.length).toBe(4); // catchup + 3

    // stat() fails for a transient error as readily as for a delete, so a file
    // that comes back unchanged must NOT replay the whole queue
    unlinkSync(path);
    await Bun.sleep(80);
    writeFileSync(path, three);
    await Bun.sleep(150);
    expect(f.out.length).toBe(4);
    expect(readCursor(cur)).toBe(3);

    // ...but appends after it came back are still delivered
    appendFileSync(path, "4\n");
    await waitFor(() => f.out.includes("4"), 2000, "line after the file returned");
    expect(readCursor(cur)).toBe(4);

    // a genuinely shorter replacement does replay, from the top
    unlinkSync(path);
    await Bun.sleep(80);
    writeFileSync(path, "fresh\n");
    await waitFor(() => f.out.includes("fresh"), 2000, "shorter replacement replays");
    await waitFor(() => readCursor(cur) === 1, 2000, "cursor reset to 1");
    f.stop();
    await f.done;
  });

  test("--no-cursor (no cursorPath) still follows from the end and writes no cursor file", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const cur = join(t.dir, "tail.cursor");
    writeFileSync(path, "old-1\nold-2\n");
    const f = follow(path);
    await Bun.sleep(60);
    expect(f.out).toEqual([]);
    expect(() => readFileSync(cur, "utf8")).toThrow();
    f.stop();
    await f.done;
  });
});
