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

function signal(g: Graduated) {
  switch (g.how) {
    case "multiple":
      return `${g.multiple && g.multiple < 100 ? g.multiple.toFixed(1) : Math.round(g.multiple ?? 0)}× since launch`;
    case "graduate":
      return "graduate()";
    case "migrate":
      return "migrated";
    case "tick":
      return "curve end reached";
  }
}

function buttons(g: Graduated, pairs: [string, string][]): Button[] {
  return pairs
    .filter(([, tpl]) => tpl)
    .map(([text, tpl]) => ({ text, url: tpl.replaceAll("{token}", g.token).replaceAll("{pool}", g.pool) }))
    .filter((b) => /^https?:\/\//.test(b.url)); // Telegram rejects the whole message on a bad button URL
}

export function formatGraduated(g: Graduated): Message {
  const l = config.links[g.pad];
  return {
    text: [
      `🎓 <b>GRADUATED · ${g.pad.toUpperCase()}</b>`,
      `<b>$${esc(g.symbol)}</b> — ${esc(g.name)}`,
      `Paired: ${esc(g.pairedSymbol ?? g.numeraire)}`,
      `Signal: ${esc(signal(g))}`,
      `CA: <code>${g.token}</code>`,
      ...(g.creator ? [`Creator: <code>${g.creator}</code>`] : []),
      `Launched → graduated: ${duration(g.graduatedAt - g.launchedAt)}`,
    ].join("\n"),
    buttons: buttons(g, [
      ["Chart", l.chart],
      ["Explorer", l.explorer],
      [g.pad === "long" ? "Long" : "Bankr", l.site],
      ["FOMO", l.fomo],
    ]),
  };
}
