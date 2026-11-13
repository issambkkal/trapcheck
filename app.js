// Trap Check: red-flag report for a Solana token from public market and on-chain risk data.
// The page's own form and the assistant's actions both call App.page, so they share one
// set of rules. Data comes from two public APIs that allow browser calls (CORS), with no
// keys: DexScreener (pairs, liquidity, volume, trades) and RugCheck (on-chain risk summary).

// The "latest/dex/tokens" endpoint lists up to 30 pools for a token: {pairs: [...]}.
const DEXSCREENER = "https://api.dexscreener.com/latest/dex/tokens/";
const RUGCHECK = "https://api.rugcheck.xyz/v1/tokens/";
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TIMEOUT_MS = 12000;
const RECENT_KEY = "trapcheck.recent.v1";
const RECENT_MAX = 10;
const YOUNG_HOURS = 30 * 24;

/** The rules, in the order the report lists them. Thresholds live here only. */
const RULES = [
  { id: "no_pair", level: "red", title: "No trading pair found", detail: "DexScreener lists no Solana pair for this address, so there is no market to check." },
  { id: "liquidity_low", level: "red", title: "Total liquidity under $10,000", detail: "Small pools let a few sells crash the price; exits get expensive or impossible." },
  { id: "liquidity_thin", level: "amber", title: "Total liquidity under $50,000", detail: "Thin pools: large sells move the price a lot." },
  { id: "age_hour", level: "red", title: "First pool created less than 1 hour ago", detail: "Most rug pulls happen in a coin's first hours." },
  { id: "age_day", level: "amber", title: "First pool created less than 24 hours ago", detail: "Very new: no track record yet." },
  { id: "dump_24h", level: "red", title: "Price down 60% or more in 24 hours", detail: "A crash of this size often follows insiders selling." },
  { id: "drop_24h", level: "amber", title: "Price down 30% or more in 24 hours", detail: "Heavy selling over the last day." },
  { id: "sell_pressure", level: "amber", title: "Sells more than twice the buys in the last hour", detail: "Counted only when the last hour has at least 30 trades." },
  { id: "fdv_vs_liquidity", level: "amber", title: "Valuation over 100x its total liquidity", detail: "Tokens under 30 days old: the quoted market value is far larger than the money actually in its pools." },
  { id: "no_links", level: "amber", title: "No website or social links listed", detail: "DexScreener shows no website or socials for this token." },
  { id: "rugcheck_danger", level: "red", title: "RugCheck: danger-level risk", detail: "RugCheck found an on-chain risk it rates as danger (listed below)." },
  { id: "rugcheck_warn", level: "amber", title: "RugCheck: warning-level risk", detail: "RugCheck found an on-chain risk it rates as a warning (listed below)." },
  { id: "lp_unlocked", level: "amber", title: "Less than half of the liquidity is locked", detail: "Tokens under 30 days old: unlocked liquidity can be pulled by its owner." },
  { id: "rugcheck_missing", level: "info", title: "RugCheck had no report", detail: "On-chain risks (mint and freeze authority, holders, liquidity locks) were not checked." },
];

/** Plain-language facts the assistant and the page both show. */
const FACTS = {
  site: "Trap Check",
  what_it_does: "Gives a red-flag report for one Solana token from public data: total liquidity, token age, price moves, buy/sell balance, valuation versus liquidity, listed links, and RugCheck's on-chain risk summary.",
  verdicts: {
    "High risk": "at least one red flag",
    "Caution": "two or more amber flags and no red flag",
    "No major red flags found": "fewer than two amber flags and no red flag. This is not a safety guarantee.",
  },
  data_sources: [
    { name: "DexScreener", url: "https://dexscreener.com", used_for: "pools, liquidity, volume, trades, price change, valuation, links" },
    { name: "RugCheck", url: "https://rugcheck.xyz", used_for: "on-chain risk summary, risk score, share of liquidity locked" },
  ],
  limits: [
    "Solana tokens only, checked by mint (token) address, not by name or ticker.",
    "Data is public and can be minutes old; it can be wrong or manipulated.",
    "No buy, sell or price advice, no price predictions, no portfolio tracking, no alerts, no wallet connection, no trading.",
    "A token with no red flags can still fail or be a scam.",
  ],
  author: { name: "issam", x: "https://x.com/issam0pc4u" },
};

/**
 * Fetch JSON with a time limit.
 *
 * :param url: The URL to read.
 * :return: {ok, status, data} where data is the parsed body or null.
 */
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: String(error && error.name === "AbortError" ? "timed out" : error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Round a number for display and for the agent, keeping it a number. */
function round(value, digits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Turn the two API answers into a report. Pure function: no fetching, no page changes.
 *
 * :param address: The mint address checked.
 * :param pairs: DexScreener pair list (may be empty).
 * :param rug: RugCheck summary or null.
 * :param now: Time of the check in ms.
 * :return: The report object.
 */
export function buildReport(address, pairs, rug, now) {
  // Only pools where this token is the base token count: a pool's price, valuation and
  // price change describe its base token, and junk tokens often list a real coin as quote.
  const solanaPairs = (Array.isArray(pairs) ? pairs : []).filter((p) => p && p.chainId === "solana"
    && p.baseToken && p.baseToken.address === address);
  // The main pool is the one with the most real trading (24h volume), not the most
  // liquidity: mispriced pools can report huge liquidity with no trades at all.
  const volume = (p) => (p.volume && p.volume.h24) || 0;
  const liq = (p) => (p.liquidity && p.liquidity.usd) || 0;
  const pair = [...solanaPairs].sort((a, b) => volume(b) - volume(a) || liq(b) - liq(a))[0] || null;
  const hits = new Set();
  const metrics = { pairs_found: solanaPairs.length };
  // Rules about valuation versus pool liquidity and unlocked liquidity apply to young
  // tokens only: established coins trade mostly on exchanges, outside these pools.
  let young = true;
  let token = { address, name: null, symbol: null };

  if (!pair) {
    hits.add("no_pair");
  } else {
    token = { address, name: pair.baseToken.name || null, symbol: pair.baseToken.symbol || null };
    // Liquidity is the total over the Solana pools priced like the main pool (valuation
    // within 10x of it), which leaves out mispriced pools; age comes from the oldest pool.
    const mainFdv = pair.fdv || pair.marketCap || null;
    const priced = (p) => !mainFdv || !(p.fdv || p.marketCap) || ((p.fdv || p.marketCap) <= mainFdv * 10 && (p.fdv || p.marketCap) >= mainFdv / 10);
    const pooled = solanaPairs.filter((p) => p.liquidity && typeof p.liquidity.usd === "number" && priced(p));
    metrics.pools_ignored_as_mispriced = solanaPairs.filter((p) => !priced(p)).length;
    const liquidity = pooled.length ? pooled.reduce((sum, p) => sum + p.liquidity.usd, 0) : null;
    const created = solanaPairs.map((p) => p.pairCreatedAt).filter((t) => typeof t === "number" && t > 0);
    const ageHours = created.length ? (now - Math.min(...created)) / 3600000 : null;
    // Price moves and trades come from the most liquid pool.
    const change24 = pair.priceChange && pair.priceChange.h24;
    const h1 = (pair.txns && pair.txns.h1) || {};
    const fdv = pair.fdv || pair.marketCap || null;
    const info = pair.info || {};
    const linkCount = (info.websites || []).length + (info.socials || []).length;
    Object.assign(metrics, {
      main_dex: pair.dexId || null,
      main_pool_url: pair.url || null,
      price_usd: pair.priceUsd ? Number(pair.priceUsd) : null,
      liquidity_usd: round(liquidity, 0),
      fdv_usd: round(fdv, 0),
      market_cap_usd: round(pair.marketCap, 0),
      pair_age_hours: round(ageHours, 1),
      price_change_pct: pair.priceChange || null,
      volume_24h_usd: round(pair.volume && pair.volume.h24, 0),
      trades_1h: { buys: h1.buys || 0, sells: h1.sells || 0 },
      trades_24h: (pair.txns && pair.txns.h24) || null,
      links_listed: linkCount,
    });
    if (typeof liquidity !== "number" || liquidity < 10000) {
      hits.add("liquidity_low");
    } else if (liquidity < 50000) {
      hits.add("liquidity_thin");
    }
    if (ageHours !== null && ageHours < 1) {
      hits.add("age_hour");
    } else if (ageHours !== null && ageHours < 24) {
      hits.add("age_day");
    }
    if (typeof change24 === "number" && change24 <= -60) {
      hits.add("dump_24h");
    } else if (typeof change24 === "number" && change24 <= -30) {
      hits.add("drop_24h");
    }
    if ((h1.buys || 0) + (h1.sells || 0) >= 30 && (h1.sells || 0) > 2 * (h1.buys || 0)) {
      hits.add("sell_pressure");
    }
    young = ageHours === null || ageHours < YOUNG_HOURS;
    if (young && fdv && typeof liquidity === "number" && liquidity > 0 && fdv / liquidity > 100) {
      hits.add("fdv_vs_liquidity");
    }
    if (linkCount === 0) {
      hits.add("no_links");
    }
  }

  const rugRisks = [];
  if (!rug) {
    hits.add("rugcheck_missing");
  } else {
    for (const risk of rug.risks || []) {
      rugRisks.push({ name: risk.name, level: risk.level, description: risk.description || "", value: risk.value || "" });
      if (risk.level === "danger") {
        hits.add("rugcheck_danger");
      } else if (risk.level === "warn") {
        hits.add("rugcheck_warn");
      }
    }
    metrics.rugcheck_score_normalised = typeof rug.score_normalised === "number" ? rug.score_normalised : null;
    metrics.lp_locked_pct = round(rug.lpLockedPct, 1);
    if (young && typeof rug.lpLockedPct === "number" && rug.lpLockedPct < 50) {
      hits.add("lp_unlocked");
    }
  }

  const flags = RULES.filter((rule) => hits.has(rule.id)).map((rule) => ({ id: rule.id, level: rule.level, title: rule.title, detail: rule.detail }));
  const reds = flags.filter((f) => f.level === "red").length;
  const ambers = flags.filter((f) => f.level === "amber").length;
  const verdict = reds > 0 ? "High risk" : ambers >= 2 ? "Caution" : "No major red flags found";
  return {
    ok: true,
    token,
    verdict,
    red_flags: reds,
    amber_flags: ambers,
    flags,
    rugcheck_risks: rugRisks,
    metrics,
    links: {
      dexscreener: (pair && pair.url) || `https://dexscreener.com/solana/${address}`,
      rugcheck: `https://rugcheck.xyz/tokens/${address}`,
    },
    checked_at: new Date(now).toISOString(),
    note: "Public data only. Not financial advice and not a safety guarantee.",
  };
}

/** The page object: state, operations and rendering. */
export class TrapCheckPage {
  constructor() {
    this.current = null;
    this.recent = TrapCheckPage.loadRecent();
    this.busy = false;
  }

  /** Read saved recent checks; the page works without storage. */
  static loadRecent() {
    try {
      const raw = globalThis.localStorage && globalThis.localStorage.getItem(RECENT_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.slice(0, RECENT_MAX) : [];
    } catch {
      return [];
    }
  }

  saveRecent() {
    try {
      if (globalThis.localStorage) {
        globalThis.localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
      }
    } catch {
      // Storage can be blocked; the list still lives in memory.
    }
  }

  /** What the site checks, how verdicts work, its sources and limits. */
  getFacts() {
    return { ...FACTS, rules: RULES.map((r) => ({ id: r.id, level: r.level, title: r.title, detail: r.detail })) };
  }

  /** The current report shown on the page and the recent checks. */
  getState() {
    return {
      current_report: this.current,
      recent_checks: this.recent.map((r) => ({
        address: r.token.address,
        symbol: r.token.symbol,
        name: r.token.name,
        verdict: r.verdict,
        red_flags: r.red_flags,
        amber_flags: r.amber_flags,
        checked_at: r.checked_at,
      })),
    };
  }

  /**
   * Check one Solana token by mint address and show the report on the page.
   *
   * :param address: The token's mint address.
   * :return: The report, or {ok: false, reason, field} when the address is refused or no
   *   data source answered.
   */
  async checkToken(address) {
    const clean = String(address || "").trim();
    if (!ADDRESS.test(clean)) {
      return { ok: false, field: "address", reason: "That is not a Solana token address: it should be 32 to 44 letters and digits, like DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263." };
    }
    if (this.busy) {
      return { ok: false, reason: "Another check is still running on the page. Try again in a few seconds." };
    }
    this.busy = true;
    TrapCheckPage.renderBusy(true, clean);
    try {
      const [dex, rug] = await Promise.all([
        fetchJson(DEXSCREENER + encodeURIComponent(clean)),
        fetchJson(`${RUGCHECK}${encodeURIComponent(clean)}/report/summary`),
      ]);
      if (!dex.ok && !rug.ok) {
        const reason = `Neither data source answered (DexScreener ${dex.status || dex.error || "no answer"}, RugCheck ${rug.status || rug.error || "no answer"}). Try again in a minute.`;
        TrapCheckPage.renderError(reason);
        return { ok: false, reason };
      }
      const pairs = dex.ok && dex.data && Array.isArray(dex.data.pairs) ? dex.data.pairs : [];
      const report = buildReport(clean, pairs, rug.ok ? rug.data : null, Date.now());
      if (!dex.ok) {
        report.note += " DexScreener did not answer, so market checks are missing.";
      }
      this.current = report;
      this.recent = [report, ...this.recent.filter((r) => r.token.address !== clean)].slice(0, RECENT_MAX);
      this.saveRecent();
      TrapCheckPage.renderReport(report);
      TrapCheckPage.renderRecent(this.recent);
      return report;
    } finally {
      this.busy = false;
      TrapCheckPage.renderBusy(false, clean);
    }
  }

  /** Forget the recent checks (the page's "Clear" button). */
  clearRecent() {
    this.recent = [];
    this.saveRecent();
    TrapCheckPage.renderRecent(this.recent);
    return { ok: true, recent_checks: [] };
  }

  // ---------- rendering (browser only) ----------

  static el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") {
        node.className = value;
      } else {
        node.setAttribute(key, value);
      }
    }
    for (const child of children) {
      if (child !== null && child !== undefined) {
        node.append(child instanceof Node ? child : String(child));
      }
    }
    return node;
  }

  static renderBusy(busy, address) {
    if (typeof document === "undefined") {
      return;
    }
    const button = document.querySelector("#check-button");
    if (button) {
      button.disabled = busy;
      button.textContent = busy ? "Checking…" : "Check token";
    }
    const input = document.querySelector("#address");
    if (input && busy) {
      input.value = address;
    }
  }

  static renderError(reason) {
    if (typeof document === "undefined") {
      return;
    }
    const box = document.querySelector("#report");
    box.replaceChildren(TrapCheckPage.el("p", { class: "report-error", role: "alert" }, reason));
  }

  static money(value) {
    return typeof value === "number" ? "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "n/a";
  }

  static age(hours) {
    if (typeof hours !== "number") {
      return "n/a";
    }
    return hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
  }

  static renderReport(report) {
    if (typeof document === "undefined") {
      return;
    }
    const el = TrapCheckPage.el;
    const m = report.metrics;
    const label = report.token.symbol ? `${report.token.name || ""} (${report.token.symbol})` : report.token.address;
    const verdictClass = report.verdict === "High risk" ? "red" : report.verdict === "Caution" ? "amber" : "green";
    const flagList = el("ul", { class: "flags" });
    for (const flag of report.flags) {
      flagList.append(el("li", { class: `flag ${flag.level}` }, el("strong", {}, flag.title), " ", el("span", {}, flag.detail)));
    }
    if (!report.flags.length) {
      flagList.append(el("li", { class: "flag green" }, el("strong", {}, "No rule matched."), " ", el("span", {}, "That is not a guarantee.")));
    }
    const risks = el("ul", { class: "risks flags" });
    for (const risk of report.rugcheck_risks) {
      risks.append(el("li", { class: `flag ${risk.level === "danger" ? "red" : risk.level === "warn" ? "amber" : "info"}` }, el("strong", {}, `${risk.name}: `), risk.description));
    }
    const change = m.price_change_pct || {};
    const rows = [
      ["Total liquidity", TrapCheckPage.money(m.liquidity_usd)],
      ["Valuation (FDV)", TrapCheckPage.money(m.fdv_usd)],
      ["Token age (oldest pool)", TrapCheckPage.age(m.pair_age_hours)],
      ["Pools found", m.pairs_found >= 30 ? "30 (DexScreener shows at most 30, so liquidity may be higher)" : String(m.pairs_found)],
      ["Price change 1h / 24h", `${change.h1 ?? "n/a"}% / ${change.h24 ?? "n/a"}%`],
      ["Volume 24h (main pool)", TrapCheckPage.money(m.volume_24h_usd)],
      ["Trades last hour (main pool)", m.trades_1h ? `${m.trades_1h.buys} buys / ${m.trades_1h.sells} sells` : "n/a"],
      ["Liquidity locked (RugCheck)", typeof m.lp_locked_pct === "number" ? `${m.lp_locked_pct}%` : "n/a"],
      ["Website / socials listed", typeof m.links_listed === "number" ? String(m.links_listed) : "n/a"],
    ];
    const table = el("table", { class: "metrics" });
    for (const [name, value] of rows) {
      table.append(el("tr", {}, el("th", { scope: "row" }, name), el("td", {}, value)));
    }
    const box = document.querySelector("#report");
    box.replaceChildren(
      el("div", { class: `verdict ${verdictClass}` },
        el("span", { class: "verdict-label" }, report.verdict),
        el("span", { class: "verdict-token" }, label),
        el("span", { class: "verdict-counts" }, `${report.red_flags} red, ${report.amber_flags} amber`)),
      el("h3", {}, "Red flags"),
      flagList,
      report.rugcheck_risks.length ? el("h3", {}, "RugCheck risks") : null,
      report.rugcheck_risks.length ? risks : null,
      el("h3", {}, "Numbers"),
      table,
      el("p", { class: "receipts" }, "Receipts: ",
        el("a", { href: report.links.dexscreener, target: "_blank", rel: "noopener" }, "DexScreener"), " · ",
        el("a", { href: report.links.rugcheck, target: "_blank", rel: "noopener" }, "RugCheck"),
        ` · checked ${report.checked_at.replace("T", " ").slice(0, 16)} UTC`),
      el("p", { class: "note" }, report.note),
    );
  }

  static renderRecent(recent) {
    if (typeof document === "undefined") {
      return;
    }
    const el = TrapCheckPage.el;
    const list = document.querySelector("#recent-list");
    if (!list) {
      return;
    }
    if (!recent.length) {
      list.replaceChildren(el("li", { class: "empty" }, "No checks yet."));
      return;
    }
    list.replaceChildren(...recent.map((r) => {
      const button = el("button", { type: "button", class: "recent-item", "data-address": r.token.address },
        el("span", { class: `dot ${r.verdict === "High risk" ? "red" : r.verdict === "Caution" ? "amber" : "green"}` }),
        `${r.token.symbol || r.token.address.slice(0, 6) + "…"}: ${r.verdict}`);
      return el("li", {}, button);
    }));
  }

  static renderRules() {
    if (typeof document === "undefined") {
      return;
    }
    const el = TrapCheckPage.el;
    const list = document.querySelector("#rules-list");
    list.replaceChildren(...RULES.map((r) => el("li", { class: `flag ${r.level}` }, el("strong", {}, r.title), " ", el("span", {}, r.detail))));
  }

  /** Wire the page's own form and buttons to the same operations the assistant uses. */
  mount() {
    if (typeof document === "undefined") {
      return;
    }
    TrapCheckPage.renderRules();
    TrapCheckPage.renderRecent(this.recent);
    document.querySelector("#check-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const result = await this.checkToken(document.querySelector("#address").value);
      if (result && result.ok === false) {
        TrapCheckPage.renderError(result.reason);
      }
    });
    document.querySelector("#recent-list").addEventListener("click", (event) => {
      const button = event.target.closest(".recent-item");
      if (button) {
        this.checkToken(button.dataset.address);
      }
    });
    document.querySelector("#clear-recent").addEventListener("click", () => this.clearRecent());
    for (const example of document.querySelectorAll("[data-example]")) {
      example.addEventListener("click", () => {
        document.querySelector("#address").value = example.dataset.example;
        document.querySelector("#address").focus();
      });
    }
  }
}

export class App {
  static page = new TrapCheckPage();
}

if (typeof window !== "undefined") {
  App.page.mount();
}
