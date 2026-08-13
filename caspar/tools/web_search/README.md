# web_search — the space's internet search + page-reader creature

A Davinci tool creature (Caspar `docker` entity) that lets a Decillion **space
search the live internet and read web pages**. Both the space's agents (through
the agent backbone's bridge executor) and people (through the tool's Victor
mini-app) use the exact same contract.

```
Victor "Search" mini-app ─host.call▶ client ─signal(as the user)▶ web_search creature ─HTTPS▶ search provider
     (the space desktop)                                              │                         + any web page
space agents ─backbone bridge▶ signal ───────────────────────────────┘
```

One creature serves **every** space. Unlike the github/sandbox tools it is **not
bound to a space** — web search is a global utility, so it needs no `space_id`,
stores no per-space state, and keeps no files of its own. It makes outbound HTTPS
directly (`requiresNetwork`), exactly like the sandbox/github tools call their
own upstream APIs.

## Providers

The search backend is pluggable and chosen at deploy time by baking a provider
API key into the creature image. `search`/`news`/`answer` normalise every backend
to the same result shape, so a caller never has to know which provider is wired.

| provider | env | notes |
|---|---|---|
| Tavily | `TAVILY_API_KEY` | also returns a synthesised `answer` |
| Brave | `BRAVE_API_KEY` (`BRAVE_SEARCH_API_KEY`) | web + news |
| SerpAPI | `SERPAPI_API_KEY` | Google results, answer box |
| Bing | `BING_SEARCH_API_KEY` | Azure Bing v7 |
| Google | `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | Programmable Search |
| DuckDuckGo | *(none)* | keyless HTML-scrape fallback, always available |

`WEB_SEARCH_PROVIDER` forces one (`tavily`/`brave`/`serpapi`/`bing`/`google`/
`duckduckgo`); the default is **auto** — the first provider whose key is present,
otherwise the keyless DuckDuckGo fallback so the tool always returns *something*.
If a keyed provider hiccups and returns nothing, the call transparently falls
back to DuckDuckGo.

> **Configure a provider key for reliable results.** The keyless DuckDuckGo
> fallback tries three endpoints in turn — the `html` and `lite` HTML endpoints
> (POSTed with a real browser User-Agent) and finally the official Instant Answer
> JSON API — but DuckDuckGo aggressively rate-limits/blocks automated searches
> from datacenter IPs and can still return **HTTP 403 / nothing**. It is a safety
> net, not a production search backend. For dependable results bake one provider
> key into the image (Tavily and Brave both have free tiers); the error message
> a failed keyless search returns says exactly this.

All credentials come from the **container environment only** — never from a
signal payload a prompt could influence, so a prompt-injected agent cannot swap
the provider or read the key.

## Actions

| function | what it does |
|---|---|
| `search` | web search → `results` = `[{title, url, snippet, published?}]` (the default) |
| `news` | recent-news search → dated results |
| `answer` | a short synthesised `answer` + its `sources` (native on Tavily, else a digest of the top results) |
| `fetch` / `read` | download a `url` and return its `title`, readable `text` (HTML stripped to article text) and outbound `links` |
| `providers` | which provider is active and which are configured |

`search`/`news` accept `count` (1–25, default 10). `news` accepts `freshness`
(`pd`/`pw`/`pm`, brave/bing) or `days` (tavily). Results and page text are capped
(`WEB_SEARCH_MAX_TEXT_CHARS`, default 40 000) so a huge page can never blow up an
LLM context or the mobile UI.

## Configuration

| env | meaning |
|---|---|
| `WEB_SEARCH_PROVIDER` | force a provider (default: auto) |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` / `SERPAPI_API_KEY` / `BING_SEARCH_API_KEY` / `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | provider keys (bake at least one for paid-quality results) |
| `WEB_SEARCH_MAX_RESULTS` | default result count (10) |
| `WEB_SEARCH_RESULTS_CAP` | hard cap on `count` (25) |
| `WEB_SEARCH_MAX_FETCH_BYTES` | max bytes downloaded per `fetch` (2 000 000) |
| `WEB_SEARCH_MAX_TEXT_CHARS` | max chars of readable text returned (40 000) |
| `WEB_SEARCH_HTTP_TIMEOUT` | per-request timeout, seconds (30) |
| `WEB_SEARCH_USER_AGENT` | User-Agent for page fetches |

## The front-end (the space desktop)

The tool has **two parts on one program**: this docker back-end (entity
`web_search`) and a downloadable Victor mini-app **front-end** (entity `frontend`,
`frontend/search.js`). The front-end is an Elpian-based JS app that runs in the
Decillion client's Victor host — the space "desktop" — not on the node. It offers
a search box with Web/News tabs, an in-app reader (via `fetch`), and "Open ↗" to
launch a result in the device browser through the client capability
`host:openUrl`. `deploy_web_search_tool.py` deploys it as a `downloadable`
`javascript` entity right after the back-end, so any space with the tool gets its
UI for free.

## Deploy

`scripts/deploy_web_search_tool.py` bakes the provider key(s) into the image,
deploys the back-end + front-end, registers the tool in the on-chain platform
registry (so `MarketService.listTools` lists it as an addable tool), and starts
it as a long-lived serving creature. `ci-deploy.sh` runs it on every deploy, and
the Nest deployer records it in the manifest under `davinci.tools["web_search"]`.
With no provider key configured the tool still deploys and works via the keyless
DuckDuckGo fallback.
