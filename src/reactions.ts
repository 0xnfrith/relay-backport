// Seen/working reaction ceremony (owner mentions only, opt-in).
//
// On sight of an owner mention: publish kind:7 reactions on the triggering
// message. They are removed (NIP-09 kind:5 delete of our own reaction ids)
// when a reply from our key lands in that channel, or by a sweep after
// `sweepAfterMs` so a consumer that died mid-task cannot strand them.
//
// Event shapes (verified against a live Buzz relay for kind:9 triggers;
// unverified for forum triggers, but the calls are identical):
//   add    = kind:7, content:<emoji>, tags:[["e", <triggerEventId>]]
//   remove = kind:5, content:"",      tags:[["e", <reactionEventId>]]
import { KIND_DELETION, KIND_REACTION } from "./mention";
import { log } from "./log";

export type Publish = (tmpl: { kind: number; tags: string[][]; content: string }) => Promise<string | null>;

export type PendingReaction = { channel: string; reactionIds: string[]; addedAt: number };

export const DEFAULT_EMOJIS = ["👀", "💬"];

export class ReactionManager {
  private readonly pending = new Map<string, PendingReaction>();

  constructor(
    private readonly publish: Publish,
    private readonly opts: { sweepAfterMs: number; emojis?: string[] },
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  pendingFor(triggerId: string): PendingReaction | undefined {
    return this.pending.get(triggerId);
  }

  /** React on a trigger. Idempotent per trigger id. */
  async react(triggerEventId: string, channel: string): Promise<void> {
    if (!channel || this.pending.has(triggerEventId)) return;
    const reactionIds: string[] = [];
    for (const emoji of this.opts.emojis ?? DEFAULT_EMOJIS) {
      try {
        const id = await this.publish({ kind: KIND_REACTION, tags: [["e", triggerEventId]], content: emoji });
        if (id) reactionIds.push(id);
      } catch {
        // best effort
      }
    }
    if (reactionIds.length > 0) {
      this.pending.set(triggerEventId, { channel, reactionIds, addedAt: Date.now() });
    }
  }

  /** A reply from our key landed in `channel`: clear every pending reaction there. */
  async onOwnReply(channel: string): Promise<number> {
    if (!channel) return 0;
    let cleared = 0;
    for (const [trigId, p] of [...this.pending]) {
      if (p.channel !== channel) continue;
      this.pending.delete(trigId);
      await this.remove(p);
      cleared++;
    }
    return cleared;
  }

  /** Delete reactions older than the sweep window. */
  async sweep(now = Date.now()): Promise<number> {
    const cutoff = now - this.opts.sweepAfterMs;
    let swept = 0;
    for (const [trigId, p] of [...this.pending]) {
      if (p.addedAt > cutoff) continue;
      this.pending.delete(trigId);
      await this.remove(p);
      swept++;
    }
    if (swept > 0) log.info("reaction sweep", { swept });
    return swept;
  }

  private async remove(p: PendingReaction): Promise<void> {
    for (const rid of p.reactionIds) {
      try {
        await this.publish({ kind: KIND_DELETION, tags: [["e", rid]], content: "" });
      } catch {
        // best effort
      }
    }
  }
}
