"""web_search tool creature — internet search + page reading for a Decillion space.

Deployed as its own Caspar ``docker`` creature (like every other Davinci tool)
and driven purely through the Caspar signalling API. Two kinds of caller reach
it, both over the same contract:

* the space's **agents**, through the agent backbone's bridge executor, so an
  agent can look things up on the live web and read pages while it works;
* the tool's **front-end** (the Victor "Search" mini-app), relayed by the client
  and signed as the human user — a search box a person can use by hand.

Unlike the github/sandbox tools this creature is **not bound to a space**: web
search is a global utility, so it needs no ``space_id`` and stores no per-space
state. It makes outbound HTTPS directly (``requires_network``), exactly like the
sandbox/github tools call their upstream APIs.

## Providers

The search backend is pluggable and chosen at deploy time by baking a provider
API key into the image. ``search``/``news``/``answer`` normalise every backend to
the same result shape, so a caller never has to know which provider is wired.

    WEB_SEARCH_PROVIDER   force a provider: tavily | brave | serpapi | bing |
                          google | duckduckgo. Default: auto — the first provider
                          whose key is present, else the keyless DuckDuckGo
                          fallback so the tool always returns *something*.

    TAVILY_API_KEY                         → tavily   (also returns an AI answer)
    BRAVE_API_KEY / BRAVE_SEARCH_API_KEY   → brave
    SERPAPI_API_KEY / SERPAPI_KEY          → serpapi  (Google results)
    BING_SEARCH_API_KEY / BING_API_KEY     → bing     (Azure Bing v7)
    GOOGLE_CSE_KEY + GOOGLE_CSE_CX         → google   (Programmable Search)
    (none)                                 → duckduckgo (HTML scrape, keyless)

All credentials come from the container environment only — never from a signal
payload a prompt could influence, so a prompt-injected agent cannot swap the
provider or exfiltrate the key.

## Functions

    search    web search → a normalised list of {title, url, snippet, ...}
    news      recent-news search (falls back to a time-scoped web search)
    answer    a short synthesised answer + its sources (native on Tavily, else a
              digest of the top web results)
    fetch     download a URL and return its readable text (HTML stripped to
              article text), plus the page title and outbound links
    read      alias of fetch
    providers report which provider is active and which are configured
"""

from __future__ import annotations

import html
import json
import os
import re
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

import requests

HTTP_TIMEOUT = float(os.environ.get("WEB_SEARCH_HTTP_TIMEOUT", "30"))
# Results / text are fed back into an LLM context and a mobile UI — cap hard so a
# huge page or a long result list can never blow either up.
MAX_RESULTS = int(os.environ.get("WEB_SEARCH_MAX_RESULTS", "10"))
RESULTS_CAP = int(os.environ.get("WEB_SEARCH_RESULTS_CAP", "25"))
MAX_FETCH_BYTES = int(os.environ.get("WEB_SEARCH_MAX_FETCH_BYTES", "2000000"))
MAX_TEXT_CHARS = int(os.environ.get("WEB_SEARCH_MAX_TEXT_CHARS", "40000"))

# A real browser User-Agent by default: many sites (and DuckDuckGo's HTML
# endpoint) 403 a request that advertises itself as a bot. Overridable.
USER_AGENT = os.environ.get(
    "WEB_SEARCH_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
)


class SearchError(RuntimeError):
    """A search/fetch operation failed; carries an HTTP-ish status for the reply."""

    def __init__(self, message: str, *, status: int = 0, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


# --------------------------------------------------------------------------- #
# Provider selection
# --------------------------------------------------------------------------- #

def _env_any(*names: str) -> str:
    for n in names:
        v = os.environ.get(n, "").strip()
        if v:
            return v
    return ""


def _tavily_key() -> str:
    return _env_any("TAVILY_API_KEY", "TAVILY_KEY")


def _brave_key() -> str:
    return _env_any("BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY")


def _serpapi_key() -> str:
    return _env_any("SERPAPI_API_KEY", "SERPAPI_KEY", "SERP_API_KEY")


def _bing_key() -> str:
    return _env_any("BING_SEARCH_API_KEY", "BING_API_KEY", "AZURE_BING_KEY")


def _google_cse() -> Tuple[str, str]:
    return _env_any("GOOGLE_CSE_KEY", "GOOGLE_API_KEY"), _env_any("GOOGLE_CSE_CX", "GOOGLE_CSE_ID")


def _configured_providers() -> List[str]:
    out: List[str] = []
    if _tavily_key():
        out.append("tavily")
    if _brave_key():
        out.append("brave")
    if _serpapi_key():
        out.append("serpapi")
    if _bing_key():
        out.append("bing")
    if all(_google_cse()):
        out.append("google")
    # DuckDuckGo needs no key and is always available as a last resort.
    out.append("duckduckgo")
    return out


def _active_provider() -> str:
    """The provider to use: the forced one if valid, else the first configured."""
    forced = os.environ.get("WEB_SEARCH_PROVIDER", "").strip().lower()
    configured = _configured_providers()
    if forced:
        if forced in ("ddg", "duckduckgo"):
            return "duckduckgo"
        if forced in configured:
            return forced
        # A provider was named but its key is missing — fail clearly rather than
        # silently searching somewhere the operator did not intend.
        raise SearchError(
            f"WEB_SEARCH_PROVIDER={forced} is set but its API key is not configured on the "
            f"web_search creature image; configured providers: {', '.join(configured)}")
    return configured[0]


# --------------------------------------------------------------------------- #
# HTTP plumbing
# --------------------------------------------------------------------------- #

def _request(method: str, url: str, *, params: Optional[Dict[str, Any]] = None,
             json_body: Any = None, data: Any = None, headers: Optional[Dict[str, str]] = None,
             timeout: Optional[float] = None, stream: bool = False) -> requests.Response:
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    try:
        return requests.request(
            method, url, params={k: v for k, v in (params or {}).items() if v not in (None, "")},
            json=json_body, data=data, headers=hdrs, timeout=timeout or HTTP_TIMEOUT, stream=stream)
    except requests.RequestException as exc:
        raise SearchError(f"upstream request failed: {exc}", status=502)


def _json(resp: requests.Response, what: str) -> Any:
    if resp.status_code >= 300:
        body: Any
        try:
            body = resp.json()
        except ValueError:
            body = (resp.text or "")[:400]
        raise SearchError(f"{what} failed ({resp.status_code}): {body}", status=resp.status_code, body=body)
    try:
        return resp.json()
    except ValueError:
        raise SearchError(f"{what} returned a non-JSON response", status=502)


def _clamp_count(payload: Dict[str, Any]) -> int:
    try:
        n = int(payload.get("count") or payload.get("num") or payload.get("max_results") or MAX_RESULTS)
    except (TypeError, ValueError):
        n = MAX_RESULTS
    return max(1, min(n, RESULTS_CAP))


def _query(payload: Dict[str, Any]) -> str:
    q = str(payload.get("query") or payload.get("q") or payload.get("text") or payload.get("task") or "").strip()
    if not q:
        raise SearchError("a search `query` is required")
    return q


def _result(title: Any, url: Any, snippet: Any, **extra: Any) -> Dict[str, Any]:
    row = {
        "title": (str(title).strip() if title else "") or str(url or ""),
        "url": str(url or "").strip(),
        "snippet": _clip(str(snippet or "").strip(), 600),
    }
    for k, v in extra.items():
        if v not in (None, ""):
            row[k] = v
    return row


def _clip(text: str, limit: int) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


# --------------------------------------------------------------------------- #
# Providers — each returns (results, answer|None)
# --------------------------------------------------------------------------- #

def _search_tavily(query: str, count: int, payload: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    body = {
        "api_key": _tavily_key(),
        "query": query,
        "max_results": count,
        "search_depth": str(payload.get("depth") or "basic"),
        "include_answer": bool(payload.get("include_answer", True)),
        "topic": "news" if payload.get("topic") == "news" else "general",
    }
    if payload.get("days"):
        body["days"] = int(payload["days"])
    data = _json(_request("POST", "https://api.tavily.com/search", json_body=body), "tavily search")
    results = [
        _result(r.get("title"), r.get("url"), r.get("content"), score=r.get("score"),
                published=r.get("published_date"))
        for r in (data.get("results") or []) if isinstance(r, dict)
    ]
    return results[:count], (data.get("answer") or None)


def _search_brave(query: str, count: int, payload: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    is_news = payload.get("topic") == "news"
    endpoint = ("https://api.search.brave.com/res/v1/news/search" if is_news
                else "https://api.search.brave.com/res/v1/web/search")
    params: Dict[str, Any] = {"q": query, "count": count}
    if payload.get("freshness"):
        params["freshness"] = str(payload["freshness"])
    data = _json(_request("GET", endpoint, params=params,
                          headers={"X-Subscription-Token": _brave_key(),
                                   "Accept": "application/json"}), "brave search")
    if is_news:
        rows = (data.get("results") or [])
        results = [_result(r.get("title"), r.get("url"), r.get("description"), published=r.get("age"))
                   for r in rows if isinstance(r, dict)]
    else:
        rows = ((data.get("web") or {}).get("results") or [])
        results = [_result(r.get("title"), r.get("url"), r.get("description"),
                           published=(r.get("page_age") or r.get("age")))
                   for r in rows if isinstance(r, dict)]
    return results[:count], None


def _search_serpapi(query: str, count: int, payload: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    is_news = payload.get("topic") == "news"
    params = {"api_key": _serpapi_key(), "q": query, "num": count,
              "engine": "google_news" if is_news else "google"}
    data = _json(_request("GET", "https://serpapi.com/search.json", params=params), "serpapi search")
    key = "news_results" if is_news else "organic_results"
    rows = data.get(key) or data.get("organic_results") or []
    results = [_result(r.get("title"), r.get("link"), r.get("snippet") or r.get("source"),
                       published=r.get("date"))
               for r in rows if isinstance(r, dict)]
    answer = None
    ab = data.get("answer_box") or {}
    if isinstance(ab, dict):
        answer = ab.get("answer") or ab.get("snippet") or None
    return results[:count], answer


def _search_bing(query: str, count: int, payload: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    is_news = payload.get("topic") == "news"
    endpoint = ("https://api.bing.microsoft.com/v7.0/news/search" if is_news
                else "https://api.bing.microsoft.com/v7.0/search")
    params: Dict[str, Any] = {"q": query, "count": count, "textDecorations": "false"}
    if payload.get("freshness"):
        params["freshness"] = str(payload["freshness"])
    data = _json(_request("GET", endpoint, params=params,
                          headers={"Ocp-Apim-Subscription-Key": _bing_key()}), "bing search")
    if is_news:
        rows = data.get("value") or []
        results = [_result(r.get("name"), r.get("url"), r.get("description"), published=r.get("datePublished"))
                   for r in rows if isinstance(r, dict)]
    else:
        rows = ((data.get("webPages") or {}).get("value") or [])
        results = [_result(r.get("name"), r.get("url"), r.get("snippet"), published=r.get("dateLastCrawled"))
                   for r in rows if isinstance(r, dict)]
    return results[:count], None


def _search_google(query: str, count: int, payload: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    key, cx = _google_cse()
    params = {"key": key, "cx": cx, "q": query, "num": min(count, 10)}
    if payload.get("topic") == "news":
        params["sort"] = "date"
    data = _json(_request("GET", "https://www.googleapis.com/customsearch/v1", params=params), "google search")
    rows = data.get("items") or []
    results = [_result(r.get("title"), r.get("link"), r.get("snippet"),
                       published=(r.get("pagemap") or {}).get("metatags", [{}])[0].get("article:published_time")
                       if isinstance(r.get("pagemap"), dict) else None)
               for r in rows if isinstance(r, dict)]
    return results[:count], None


def _search_duckduckgo(query: str, count: int, payload: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Keyless fallback: DuckDuckGo's no-JS HTML endpoints, parsed for result rows.

    No API key exists for DuckDuckGo web results, so we POST the search to its
    lightweight HTML endpoints (a **POST** with form data + a real browser
    User-Agent — a bare GET or a bot UA gets a 403) and extract the anchors. We
    try `html.duckduckgo.com` first and fall back to the even simpler
    `lite.duckduckgo.com`, so a 403/anti-bot block on one still returns results.
    Best-effort — the safety net that keeps the tool useful with no paid provider.
    """
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://duckduckgo.com/",
        "Origin": "https://duckduckgo.com",
    }
    form = {"q": query, "kl": "us-en", "b": ""}
    endpoints = ("https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/")
    last_status = 0
    last_err = ""
    for url in endpoints:
        try:
            resp = _request("POST", url, data=form, headers=headers)
        except SearchError as exc:
            last_err = str(exc)
            continue
        last_status = resp.status_code
        if resp.status_code >= 300:
            continue
        results = _parse_ddg_html(resp.text or "", count)
        if results:
            return results[:count], None
    # Last keyless resort: DuckDuckGo's official Instant Answer JSON API. It does
    # not return a full web-result page, but it rarely blocks datacenter IPs, so
    # it keeps the tool returning *something* (a direct answer + related links)
    # when the HTML endpoints are 403'd.
    try:
        ia_results, ia_answer = _ddg_instant_answer(query, count)
        if ia_results or ia_answer:
            return ia_results[:count], ia_answer
    except SearchError as exc:
        last_err = str(exc)
    detail = f"HTTP {last_status}" if last_status else (last_err or "no response")
    raise SearchError(
        "duckduckgo (the keyless fallback) returned no results (" + detail + "); "
        "DuckDuckGo rate-limits/blocks automated searches, so configure a search-provider "
        "API key (TAVILY_API_KEY / BRAVE_API_KEY / SERPAPI_API_KEY / BING_SEARCH_API_KEY / "
        "GOOGLE_CSE_KEY+GOOGLE_CSE_CX) on the web_search creature for reliable results",
        status=last_status or 502)


def _parse_ddg_html(text: str, count: int) -> List[Dict[str, Any]]:
    """Extract result rows from either DuckDuckGo HTML endpoint's markup."""
    results: List[Dict[str, Any]] = []
    try:
        from bs4 import BeautifulSoup  # type: ignore
        soup = BeautifulSoup(text, "html.parser")
        # html.duckduckgo.com: <a class="result__a">; snippet in .result__snippet.
        anchors = soup.select("a.result__a")
        if anchors:
            for a in anchors:
                href = _ddg_unwrap(a.get("href") or "")
                title = a.get_text(" ", strip=True)
                snippet = ""
                parent = a.find_parent(class_=re.compile("result"))
                if parent is not None:
                    sn = parent.select_one(".result__snippet")
                    if sn is not None:
                        snippet = sn.get_text(" ", strip=True)
                if href and not href.startswith("https://duckduckgo.com"):
                    results.append(_result(title, href, snippet))
                if len(results) >= count:
                    return results
        # lite.duckduckgo.com: <a class="result-link"> rows + .result-snippet cells.
        lite = soup.select("a.result-link")
        for a in lite:
            href = _ddg_unwrap(a.get("href") or "")
            title = a.get_text(" ", strip=True)
            snippet = ""
            tr = a.find_parent("tr")
            sn = None
            if tr is not None and tr.find_next_sibling("tr") is not None:
                sn = tr.find_next_sibling("tr").select_one(".result-snippet")
            if sn is not None:
                snippet = sn.get_text(" ", strip=True)
            if href and not href.startswith("https://duckduckgo.com"):
                results.append(_result(title, href, snippet))
            if len(results) >= count:
                return results
    except Exception:  # noqa: BLE001 — regex fallback if bs4 is unavailable
        for m in re.finditer(r'result(?:__a|-link)"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', text, re.S):
            href = _ddg_unwrap(html.unescape(m.group(1)))
            title = re.sub(r"<[^>]+>", "", m.group(2)).strip()
            if href and not href.startswith("https://duckduckgo.com"):
                results.append(_result(html.unescape(title), href, ""))
            if len(results) >= count:
                break
    return results


def _ddg_instant_answer(query: str, count: int) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """DuckDuckGo Instant Answer API (JSON, keyless, datacenter-friendly).

    Returns a direct answer (``AbstractText``) when there is one, plus the
    ``RelatedTopics`` flattened into result rows. Not a full web-result page, but
    a reliable last resort when the HTML endpoints are blocked."""
    resp = _request("GET", "https://api.duckduckgo.com/",
                    params={"q": query, "format": "json", "no_html": "1",
                            "no_redirect": "1", "t": "decillion"},
                    headers={"Accept": "application/json"})
    if resp.status_code >= 300:
        raise SearchError(f"duckduckgo instant-answer failed ({resp.status_code})", status=resp.status_code)
    try:
        data = resp.json()
    except ValueError:
        return [], None
    if not isinstance(data, dict):
        return [], None
    answer = str(data.get("AbstractText") or data.get("Answer") or "").strip() or None
    results: List[Dict[str, Any]] = []
    abstract_url = str(data.get("AbstractURL") or "").strip()
    if abstract_url and answer:
        results.append(_result(data.get("Heading") or query, abstract_url, answer))

    def _flatten(topics: Any) -> None:
        for t in topics if isinstance(topics, list) else []:
            if not isinstance(t, dict):
                continue
            if isinstance(t.get("Topics"), list):
                _flatten(t["Topics"])
                continue
            url = str(t.get("FirstURL") or "").strip()
            text = str(t.get("Text") or "").strip()
            if url and text:
                # DDG "Text" is "Title description…"; split the first sentence-ish
                # chunk as the title so rows aren't one long blob.
                title = text.split(" - ", 1)[0][:120] if " - " in text else text[:120]
                results.append(_result(title, url, text))
            if len(results) >= count:
                return

    _flatten(data.get("RelatedTopics"))
    return results[:count], answer


def _ddg_unwrap(href: str) -> str:
    """DuckDuckGo wraps result links in a /l/?uddg=<encoded> redirect — unwrap it."""
    if not href:
        return ""
    if href.startswith("//"):
        href = "https:" + href
    parsed = urllib.parse.urlparse(href)
    if parsed.path.endswith("/l/") or "uddg=" in (parsed.query or ""):
        q = urllib.parse.parse_qs(parsed.query)
        if q.get("uddg"):
            return urllib.parse.unquote(q["uddg"][0])
    return href


_PROVIDER_FN = {
    "tavily": _search_tavily,
    "brave": _search_brave,
    "serpapi": _search_serpapi,
    "bing": _search_bing,
    "google": _search_google,
    "duckduckgo": _search_duckduckgo,
}


def _run_search(payload: Dict[str, Any], *, topic: Optional[str] = None) -> Dict[str, Any]:
    query = _query(payload)
    count = _clamp_count(payload)
    if topic:
        payload = {**payload, "topic": topic}
    provider = _active_provider()
    fn = _PROVIDER_FN[provider]
    results, answer = fn(query, count, payload)
    # If a keyed provider returns nothing (transient upstream hiccup), fall back
    # to the keyless DuckDuckGo scrape so the caller still gets results.
    if not results and provider != "duckduckgo":
        try:
            results, _ = _search_duckduckgo(query, count, payload)
            provider = provider + "+duckduckgo"
        except SearchError:
            pass
    return {"results": results, "answer": answer, "provider": provider, "query": query}


# --------------------------------------------------------------------------- #
# Actions
# --------------------------------------------------------------------------- #

def _a_search(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = _run_search(payload)
    return {"ok": True, "action": "search", "query": out["query"], "provider": out["provider"],
            "count": len(out["results"]), "results": out["results"],
            **({"answer": out["answer"]} if out["answer"] else {})}


def _a_news(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = _run_search(payload, topic="news")
    return {"ok": True, "action": "news", "query": out["query"], "provider": out["provider"],
            "count": len(out["results"]), "results": out["results"]}


def _a_answer(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = _run_search({**payload, "include_answer": True})
    answer = out["answer"]
    if not answer:
        # No native answer (non-Tavily provider): synthesise a short digest from
        # the top snippets so `answer` always returns something useful.
        parts = [f"- {r['title']}: {r['snippet']}" for r in out["results"][:5] if r.get("snippet")]
        answer = ("Based on the top results:\n" + "\n".join(parts)) if parts else \
            "No answer could be synthesised from the available results."
    sources = out["results"][:5]
    result: Dict[str, Any] = {"ok": True, "action": "answer", "query": out["query"],
                              "provider": out["provider"], "answer": answer, "sources": sources}
    # Choose the reply shape by how we were called: a chat command (the client
    # stamps `chat_text`/`args`) gets a filled "answer" widget — the widget
    # template this command registered — so the user sees an interactive answer
    # card; an agent (structured `query`, no chat markers) gets the plain result.
    if payload.get("chat_text") or payload.get("args"):
        result["widget"] = {
            "kind": "answer",
            "title": f"Answer · {out['query']}"[:80],
            "summary": answer if len(answer) <= 400 else answer[:400] + "…",
            "status": out["provider"],
            "data": {
                "query": out["query"],
                "answer": answer,
                "sources": [{"title": s.get("title"), "url": s.get("url")} for s in sources],
            },
        }
    return result


# --------------------------------------------------------------------------- #
# Fetch — download a URL and return its readable text
# --------------------------------------------------------------------------- #

def _normalize_url(raw: str) -> str:
    url = str(raw or "").strip()
    if not url:
        raise SearchError("a `url` is required")
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise SearchError(f"unsupported or malformed url: {raw!r}")
    return url


def _extract_text(html_text: str, base_url: str) -> Tuple[str, str, List[Dict[str, str]]]:
    """Strip an HTML document to (title, readable text, outbound links)."""
    try:
        from bs4 import BeautifulSoup  # type: ignore
    except Exception:  # noqa: BLE001 — regex fallback
        title = ""
        m = re.search(r"<title[^>]*>(.*?)</title>", html_text, re.S | re.I)
        if m:
            title = html.unescape(re.sub(r"\s+", " ", m.group(1)).strip())
        stripped = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html_text)
        stripped = re.sub(r"(?s)<[^>]+>", " ", stripped)
        text = html.unescape(re.sub(r"[ \t]*\n[ \t]*", "\n", re.sub(r"[ \t]+", " ", stripped))).strip()
        return title, text, []

    soup = BeautifulSoup(html_text, "html.parser")
    title = ""
    if soup.title and soup.title.string:
        title = re.sub(r"\s+", " ", soup.title.string).strip()
    for tag in soup(["script", "style", "noscript", "template", "svg", "iframe"]):
        tag.decompose()
    # Prefer the main article body when present; else the whole document.
    root = soup.find("article") or soup.find("main") or soup.body or soup
    lines: List[str] = []
    for el in root.find_all(["h1", "h2", "h3", "h4", "li", "p", "pre", "blockquote"]):
        chunk = el.get_text(" ", strip=True)
        if chunk:
            prefix = "# " if el.name in ("h1", "h2", "h3", "h4") else ""
            lines.append(prefix + chunk)
    text = "\n".join(lines).strip()
    if not text:  # very unstructured page — fall back to a flat text dump
        text = root.get_text("\n", strip=True)
    links: List[Dict[str, str]] = []
    seen = set()
    for a in root.find_all("a", href=True):
        href = urllib.parse.urljoin(base_url, a["href"].strip())
        if not href.startswith(("http://", "https://")) or href in seen:
            continue
        label = a.get_text(" ", strip=True)
        if label:
            links.append({"text": _clip(label, 120), "url": href})
            seen.add(href)
        if len(links) >= 50:
            break
    return title, text, links


def _a_fetch(payload: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_url(payload.get("url") or payload.get("link") or payload.get("query"))
    resp = _request("GET", url, headers={"Accept": "text/html,application/xhtml+xml,*/*"}, stream=True)
    if resp.status_code >= 400:
        raise SearchError(f"fetch failed ({resp.status_code}) for {url}", status=resp.status_code)
    ctype = (resp.headers.get("Content-Type") or "").lower()
    raw = resp.raw.read(MAX_FETCH_BYTES + 1, decode_content=True) if hasattr(resp, "raw") else resp.content
    if raw is None:
        raw = resp.content
    truncated = len(raw) > MAX_FETCH_BYTES
    raw = raw[:MAX_FETCH_BYTES]
    body = raw.decode(resp.encoding or "utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw)

    final_url = str(resp.url or url)
    if "html" in ctype or "xml" in ctype or (not ctype and "<html" in body[:2000].lower()):
        title, text, links = _extract_text(body, final_url)
        return {
            "ok": True, "action": "fetch", "url": final_url, "status": resp.status_code,
            "content_type": ctype or "text/html", "title": title,
            "text": _clip(text, MAX_TEXT_CHARS), "links": links,
            "truncated": truncated or len(text) > MAX_TEXT_CHARS,
            "text_chars": min(len(text), MAX_TEXT_CHARS),
        }
    # Non-HTML (JSON, plain text, markdown, …) — return the body verbatim.
    return {
        "ok": True, "action": "fetch", "url": final_url, "status": resp.status_code,
        "content_type": ctype or "text/plain", "title": "",
        "text": _clip(body, MAX_TEXT_CHARS), "links": [],
        "truncated": truncated or len(body) > MAX_TEXT_CHARS,
        "text_chars": min(len(body), MAX_TEXT_CHARS),
    }


def _a_providers(payload: Dict[str, Any]) -> Dict[str, Any]:
    configured = _configured_providers()
    try:
        active = _active_provider()
        err = None
    except SearchError as exc:
        active, err = None, str(exc)
    return {"ok": True, "action": "providers", "active": active,
            "configured": configured, "keyless_fallback": "duckduckgo",
            **({"error": err} if err else {})}


_ACTIONS = {
    "search": _a_search,
    "web_search": _a_search,
    "web": _a_search,
    "news": _a_news,
    "answer": _a_answer,
    "ask": _a_answer,
    "fetch": _a_fetch,
    "read": _a_fetch,
    "read_url": _a_fetch,
    "open": _a_fetch,
    "providers": _a_providers,
    "status": _a_providers,
}


def _normalize_action(function_name: str, payload: Dict[str, Any]) -> str:
    for candidate in (payload.get("action"), payload.get("function"), function_name):
        if isinstance(candidate, str) and candidate.strip() and candidate.strip() != "invoke":
            return candidate.strip().lower()
    # Bare `invoke` with a url ⇒ fetch; with a query ⇒ search.
    if payload.get("url") or payload.get("link"):
        return "fetch"
    return "search"


def invoke(function_name: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = dict(payload or {})
    action = _normalize_action(function_name, payload)
    handler = _ACTIONS.get(action)
    if handler is None:
        return {"ok": False, "error": f"unknown action '{action}'", "actions": sorted(set(_ACTIONS))}
    try:
        return handler(payload)
    except SearchError as exc:
        return {"ok": False, "action": action, "error": str(exc), "status": exc.status or None}
    except requests.RequestException as exc:
        return {"ok": False, "action": action, "error": f"network error: {exc}"}
