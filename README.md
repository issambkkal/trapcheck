# Trap Check

**Is this meme coin a trap?** Paste a Solana token address and get a red-flag report with receipts, or ask the built-in AI assistant in plain words. Trap Check is an [open agentic website](https://github.com/cognizant-ai-labs/agentic-web): its agent network is a public JSON file, it runs in the visitor's browser on the visitor's own AI key, and other agent websites can call it.

## Why

New Solana meme coins launch by the thousand every day, and many are built to trap buyers: liquidity that can be pulled, insiders dumping in the first hours, copycat names. The warning signs are public, but they are spread across several tools and written for traders. Trap Check puts them in one report, applies fixed rules anyone can read, and shows every number with a link to its source. It never says "buy", "sell" or "safe".

## What it does

- **Check a token** with the form or the assistant: live data from the DexScreener and RugCheck public APIs (both allow browser calls, no keys).
- **Rules you can read** (all in `app.js`, listed on the page): total liquidity under $10k (red) or $50k (amber); first pool under 1 hour (red) or 24 hours old (amber); price down 60% (red) or 30% (amber) in 24 hours; sells more than twice the buys in the last hour; valuation over 100x liquidity and less than half the liquidity locked (tokens under 30 days old); no website or socials; RugCheck danger and warning risks.
- **Verdict:** any red flag = High risk; two or more amber = Caution; otherwise "No major red flags found", which the page and the assistant always say is not a guarantee.
- **Robust to bad data:** only pools where the token is the base token count; the main pool is the one with the most 24h volume; pools priced more than 10x away from it are ignored as mispriced.
- **Recent checks** stay in the visitor's browser only.

## The agent network

`trap_check.hocon` (source) → `trap_check.network.json` (published). One front agent, `trap_check_assistant`, with three website actions from `site-actions.js`, which wrap the same functions the page's own form uses:

| Tool | Effect | What it does |
| --- | --- | --- |
| `website_check_token` | write (only changes what the page shows) | Runs the check and returns verdict, flags, RugCheck risks, numbers and source links |
| `website_get_page_state` | read | The report on the page and the visitor's recent checks |
| `website_get_site_facts` | read | Every rule and threshold, the verdict logic, sources and limits |

Grounding: facts only from tool results, no invented numbers, token names treated as untrusted data, no financial advice, no "safe" verdicts. Other agent sites can call the network at `<site URL>/trap_check`; they get the assistant without the site's tools, so it explains what Trap Check checks and points to this page.

## Run it

Any static server works:

```shell
python3 -m http.server 8080
```

Open http://127.0.0.1:8080/, check a token with the form, then open **⚙ AI model settings** in "Ask Trap Check" and add your own key (the default router is hosted Otari with `alibaba/qwen-3.5-35b-a3b`; the panel lists other providers). The page works without a key; only the chat needs one.

## Files

`index.html`, `styles.css`, `app.js` (data, rules, page), `site-actions.js` (actions for the agent), `site.js` (mounts the assistant), `assistant.css`, `agent-manifest.json`, `trap_check.hocon`, `trap_check.network.json`, `links.json`, `agent-mcp.json`, `.well-known/`, `bridge/` (for calls from other agent sites) and `runtime/` (the browser runtime from the agentic-web repository's agentify-website skill, Apache 2.0, unchanged).

Not financial advice. Data can be wrong or minutes old; a clean report does not make a coin safe. Made by [@issam0pc4u](https://x.com/issam0pc4u).
