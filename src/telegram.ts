import { errMsg, log, sleep } from "./log";
import type { Pad } from "./types";

export type Button = { text: string; url: string };
export type Message = { text: string; buttons: Button[] };

const CHANNEL_GAP_MS = 1_000; // ≤ 1 msg/s per channel
const CHANNEL_PER_MIN = 20; // ≤ ~20 msg/min per channel
const GLOBAL_GAP_MS = 34; // ≤ ~30 msg/s across the bot
const MAX_TRIES = 5;

let globalNext = 0;

/** One row up to 3 buttons; 2 per row beyond that so labels stay readable on phones. */
const rows = (b: Button[]) => (b.length <= 3 ? [b] : Array.from({ length: Math.ceil(b.length / 2) }, (_, i) => b.slice(i * 2, i * 2 + 2)));

type SendResult = { ok: true } | { ok: false; retryAfter?: number; error: string };

async function sendMessage(token: string, chatId: string, m: Message): Promise<SendResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: m.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(m.buttons.length ? { reply_markup: { inline_keyboard: rows(m.buttons) } } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (body.ok) return { ok: true };
    return { ok: false, retryAfter: body.parameters?.retry_after, error: `${res.status} ${body.description ?? ""}`.trim() };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** One queue per channel so a burst on one never delays the other; 429s only pause their own channel. */
class ChannelQueue {
  delivered = 0;
  dropped = 0;
  private items: { m: Message; tries: number }[] = [];
  private sent: number[] = [];
  private blockedUntil = 0;
  private running = false;

  constructor(
    readonly name: Pad,
    private token: string,
    private chatId: string,
  ) {}

  get size() {
    return this.items.length; // the in-flight message stays at items[0] until done
  }

  push(m: Message) {
    this.items.push({ m, tries: 0 });
    void this.run();
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length) {
        await this.waitTurn();
        const item = this.items[0];
        const r = await sendMessage(this.token, this.chatId, item.m);
        this.sent.push(Date.now());
        if (r.ok) {
          this.items.shift();
          this.delivered++;
        } else if (r.retryAfter) {
          this.blockedUntil = Date.now() + r.retryAfter * 1000;
          log("telegram", this.name, `429, retry after ${r.retryAfter}s`);
        } else if (++item.tries >= MAX_TRIES) {
          this.items.shift();
          this.dropped++;
          log("telegram", this.name, "dropped message:", r.error);
        } else {
          this.blockedUntil = Date.now() + 5_000 * item.tries;
          log("telegram", this.name, `send failed (try ${item.tries}):`, r.error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async waitTurn() {
    for (;;) {
      const now = Date.now();
      this.sent = this.sent.filter((t) => now - t < 60_000);
      let wait = Math.max(this.blockedUntil - now, (this.sent.at(-1) ?? 0) + CHANNEL_GAP_MS - now);
      if (this.sent.length >= CHANNEL_PER_MIN) wait = Math.max(wait, this.sent[0] + 60_000 - now);
      if (wait <= 0) {
        const slot = Math.max(globalNext, now);
        globalNext = slot + GLOBAL_GAP_MS;
        if (slot > now) await sleep(slot - now);
        return;
      }
      await sleep(wait);
    }
  }
}

export class Poster {
  private queues: Record<Pad, ChannelQueue>;

  constructor(token: string, channels: Record<Pad, string>) {
    this.queues = {
      long: new ChannelQueue("long", token, channels.long),
      bankr: new ChannelQueue("bankr", token, channels.bankr),
    };
  }

  post(pad: Pad, m: Message) {
    this.queues[pad].push(m);
  }

  pendingCount() {
    return this.queues.long.size + this.queues.bankr.size;
  }

  stats(pad: Pad) {
    const q = this.queues[pad];
    return { delivered: q.delivered, dropped: q.dropped, pending: q.size };
  }

  /** Resolves true when both queues are empty, false on timeout. */
  async drain(timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    while (this.pendingCount() > 0) {
      if (Date.now() >= end) return false;
      await sleep(200);
    }
    return true;
  }
}
