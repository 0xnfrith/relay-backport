import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  filterCatchUp,
  formatShow,
  mentionHits,
  readCompleteTailLines,
  resolveMention,
  showDeliveries,
  ShowError,
} from "../src/show";
import { splitBlockEntries } from "../src/view";
import { tmpDir } from "./helpers/tmp";

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const HIDE = "c".repeat(64);
const NICK = "1".repeat(64);

function mention(id: string, over: Record<string, unknown> = {}): string {
  return `MENTION|${JSON.stringify({
    kind: 9,
    from: NICK.slice(0, 8),
    h: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    content: over.content ?? "body",
    id,
    tags: over.tags ?? [["e", "rootid", "", "root"], ["p", HIDE]],
    ...over,
  })}`;
}

describe("readCompleteTailLines", () => {
  test("drops a partial last line and a partial first line when the window starts mid-file", () => {
    const t = tmpDir();
    const path = join(t.dir, "d.jsonl");
    writeFileSync(path, "EVENT|session|new|s1\nMENTION|{\"id\":\"x\"}\npartial");
    expect(readCompleteTailLines(path)).toEqual(["EVENT|session|new|s1", 'MENTION|{"id":"x"}']);
    t.cleanup();
  });

  test("missing file is a ShowError", () => {
    expect(() => readCompleteTailLines("/no/such/deliveries.jsonl")).toThrow(ShowError);
    expect(() => readCompleteTailLines("/no/such/deliveries.jsonl")).toThrow(/not found/);
  });
});

describe("resolveMention", () => {
  test("--last is the newest parseable MENTION; --id matches a prefix; ambiguous prefixes error", () => {
    const lines = ["EVENT|session|new|s1", mention(OLD, { content: "older" }), mention(NEW, { content: "newer" })];
    const hits = mentionHits(lines);
    expect(resolveMention(hits).id).toBe(NEW);
    expect(resolveMention(hits, "aaaa").id).toBe(OLD);
    expect(resolveMention(hits, NEW.slice(0, 12)).id).toBe(NEW);
    expect(() => resolveMention(hits, "zzzz")).toThrow(/no matching/);
    // two ids sharing a prefix
    const clash = mentionHits([mention("aa" + "1".repeat(62)), mention("aa" + "2".repeat(62))]);
    expect(() => resolveMention(clash, "aa")).toThrow(/matches 2 records/);
  });
});

describe("filterCatchUp", () => {
  test("hides matching authors in block prose and event entries; a format change keeps the block", () => {
    const block = `[1] me (${HIDE}) (t): hide me\n[2] them (${NICK}) (t): keep me`;
    const { kept, hidden } = filterCatchUp(
      [
        { kind: "block", event_id: NEW, at: 1, text: block },
        { kind: "event", event_id: OLD, at: 2, text: `[previously delivered mention] from ${HIDE} · t · event ${OLD}\nown` },
        { kind: "event", event_id: "d".repeat(64), at: 3, text: `[previously delivered mention] from ${NICK} · t · event x\nkept event` },
      ],
      [HIDE.slice(0, 8)],
    );
    expect(hidden).toBe(2);
    expect(kept.join("\n")).toContain("keep me");
    expect(kept.join("\n")).toContain("kept event");
    expect(kept.join("\n")).not.toContain("hide me");
    expect(kept.join("\n")).not.toContain("own");

    const degraded = filterCatchUp([{ kind: "block", event_id: "e", at: 1, text: "no heads here" }], [HIDE]);
    expect(degraded.hidden).toBe(0);
    expect(degraded.kept).toEqual(["no heads here"]);
    expect(splitBlockEntries("no heads here")[0]!.pubkey).toBe("");
  });
});

describe("showDeliveries", () => {
  test("prints header, full message, filtered catch-up, hidden count; --raw is the untouched record", () => {
    const t = tmpDir();
    const path = join(t.dir, "d.jsonl");
    const block = `[1] me (${HIDE}) (t): hide me\n[2] them (${NICK}) (t): the catch-up that should print`;
    writeFileSync(
      path,
      [
        "EVENT|session|new|s1",
        mention(OLD, { content: "older mention body", thread_context: [] }),
        mention(NEW, {
          content: "latest mention body",
          tags: [["e", "rootid", "", "root"], ["e", OLD, "", "reply"], ["p", HIDE], ["p", NICK]],
          thread_context: [
            { kind: "event", event_id: OLD, at: 1, text: `from ${NICK} · earlier event` },
            { kind: "block", event_id: NEW, at: 2, text: block },
          ],
        }),
        "",
      ].join("\n"),
    );

    const out = showDeliveries({ path, hide: [HIDE.slice(0, 8)] });
    expect(out).toContain(`${NEW} from=${NICK.slice(0, 8)} h=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa root=rootid reply=${OLD} p=${HIDE},${NICK}`);
    expect(out).toContain("latest mention body");
    expect(out).toContain("the catch-up that should print");
    expect(out).toContain("from " + NICK);
    expect(out).toContain("1 message hidden");
    expect(out).not.toContain("hide me");

    const pref = showDeliveries({ path, id: "aaaa", hide: [HIDE] });
    expect(pref).toContain("older mention body");
    expect(pref).toContain(OLD);

    const raw = showDeliveries({ path, raw: true });
    expect(raw.startsWith("MENTION|")).toBe(true);
    expect(raw).toContain(NEW);
    expect(raw.startsWith("MENTION|")).toBe(true);

    t.cleanup();
  });

  test("a trailing partial line is ignored so a writer mid-append cannot break show", () => {
    const t = tmpDir();
    const path = join(t.dir, "d.jsonl");
    writeFileSync(path, mention(OLD, { content: "complete" }) + "\n");
    appendFileSync(path, "MENTION|{\"id\":\"" + NEW.slice(0, 10));
    const out = showDeliveries({ path });
    expect(out).toContain("complete");
    expect(out).toContain(OLD);
    expect(out).not.toContain(NEW);
    t.cleanup();
  });
});

describe("formatShow", () => {
  test("always reports the hidden count, including zero", () => {
    const rendered = formatShow({ id: NEW, from: "12345678", h: "h", content: "hi", tags: [], thread_context: [] }, []);
    expect(rendered).toBe(`${NEW} from=12345678 h=h root=- reply=- p=-\nhi\n0 messages hidden`);
  });
});
