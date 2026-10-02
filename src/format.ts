import { config } from "./config";
import type { Button, Message } from "./telegram";
import type { Graduated } from "./types";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function duration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

export function usd(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

function buttons(g: Graduated, pairs: [string, string][]): Button[] {
  return pairs
    .filter(([, tpl]) => tpl)
    .map(([text, tpl]) => ({ text, url: tpl.replaceAll("{token}", g.token).replaceAll("{pool}", g.pool) }))
    .filter((b) => /^https?:\/\//.test(b.url)); // Telegram rejects the whole message on a bad button URL
}

export function formatGraduated(g: Graduated): Message {
  const head = [`🎓 <b>GRADUATED · ${g.pad.toUpperCase()}</b>`, `<b>$${esc(g.symbol)}</b> — ${esc(g.name)}`];

  if (g.pad === "long") {
    const l = config.links.long;
    return {
      text: [
        ...head,
        `Paired: ${esc(g.pairedSymbol ?? g.numeraire)}`,
        `CA: <code>${g.token}</code>`,
        ...(g.creator ? [`Creator: <code>${g.creator}</code>`] : []),
        `Launched → graduated: ${duration(g.graduatedAt - g.launchedAt)}`,
      ].join("\n"),
      buttons: buttons(g, [["Chart", l.chart], ["Explorer", l.explorer], ["Long", l.site]]),
    };
  }

  const b = config.links.bankr;
  const rule = g.rule === "mcap" ? `mcap ≥ ${usd(config.bankrMcapUsd)}` : "curve exhausted";
  return {
    text: [
      ...head,
      `Rule: ${esc(rule)}`,
      `CA: <code>${g.token}</code>`,
      ...(g.mcapUsd !== undefined ? [`MC: ${usd(g.mcapUsd)}`] : []),
    ].join("\n"),
    buttons: buttons(g, [["Chart", b.chart], ["Basescan", b.explorer], ["Bankr", b.site]]),
  };
}
