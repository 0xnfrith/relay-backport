import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastLines, tailFile } from "../src/tail";
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
