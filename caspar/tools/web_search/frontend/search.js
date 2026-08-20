// web_search — the tool's front-end (a Victor "mini app").
//
// This runs on the Elpian VM inside the Decillion client (the space "desktop"),
// NOT on the Caspar node. It is deployed as the downloadable `frontend` entity
// on the web_search tool's own program, fetched at runtime by the client and run
// in the Victor React-Native host. It renders a search box + results and reaches
// the web_search back-end creature over the host bridge — every request is signed
// with the human user's identity by the host, never by this sandboxed guest.
//
// Wire to the host:
//   * `hostCall(fn, args, cb)` → askHost("host.call", …) → the client signs a
//     Caspar signal to THIS tool's back-end (`{ function: fn, payload: args }`)
//     as the logged-in user, and delivers the reply back via `__hostReply`.
//   * `host:openUrl` opens a result link in the device browser.
//   * `__CTX` (injected by the client before this source) carries the theme.
//
// Written in a conservative JS style (var, function expressions, no template
// literals, no string[i] indexing) to stay comfortably inside js2elpian.

import 'reactnative.js';

// --------------------------------------------------------------------------- //
// Host bridge (guest side)                                                     //
// --------------------------------------------------------------------------- //

var __hostSeq = 0;
var __hostCbs = {};

// The host invokes this named global with [rid, ok, data] when a host.call
// settles. rid is a STRING (the Elpian VM keys maps by string only).
function __hostReply(a) {
  var rid = '' + a[0];
  var ok = a[1];
  var data = a[2];
  var cb = __hostCbs[rid];
  if (cb != null) {
    __hostCbs[rid] = null;
    cb(ok ? null : data, ok ? data : null);
  }
}

function hostCall(method, payload, cb) {
  __hostSeq = __hostSeq + 1;
  var rid = '' + __hostSeq;
  __hostCbs[rid] = cb;
  askHost('host.call', [{ rid: rid, method: method, payload: payload }]);
}

function openUrl(url) {
  // Best-effort: the client handles `host:openUrl` (see VictorDesktop). If it is
  // unavailable the call is simply a no-op.
  hostCall('host:openUrl', { url: url }, function () {});
}

// --------------------------------------------------------------------------- //
// Theme                                                                        //
// --------------------------------------------------------------------------- //

function ctx() {
  return (typeof __CTX !== 'undefined' && __CTX != null) ? __CTX : {};
}

function theme() {
  var t = ctx().theme;
  if (t == null) t = {};
  return {
    bg: t.bg || '#0b1220',
    surface: t.surface || '#111a2e',
    surfaceAlt: t.surfaceAlt || '#16223b',
    line: t.line || '#22304d',
    text: t.text || '#e6edf7',
    muted: t.muted || '#8ea3c4',
    accent: t.accent || '#4ade80',
    accentSoft: t.accentSoft || 'rgba(74,222,128,0.14)',
    onAccent: t.onAccent || '#052e16',
    danger: t.danger || '#f87171',
    link: t.link || '#7dd3fc'
  };
}

// --------------------------------------------------------------------------- //
// Helpers                                                                      //
// --------------------------------------------------------------------------- //

function hostOfUrl(url) {
  var s = '' + (url || '');
  var i = s.indexOf('://');
  if (i >= 0) s = s.substring(i + 3);
  var slash = s.indexOf('/');
  if (slash >= 0) s = s.substring(0, slash);
  return s;
}

// --------------------------------------------------------------------------- //
// State                                                                        //
// --------------------------------------------------------------------------- //

var S = {
  query: '',
  mode: 'search',   // 'search' | 'news'
  loading: false,
  error: null,
  answer: null,
  provider: null,
  results: [],
  reader: null      // { url, title, text, loading, error }
};

var W = {};
var WW = {};

// --------------------------------------------------------------------------- //
// Data                                                                         //
// --------------------------------------------------------------------------- //

function runSearch() {
  var q = (S.query || '').trim ? (S.query || '').trim() : S.query;
  if (q == null) q = '';
  if (q === '') return;
  S.loading = true;
  S.error = null;
  S.answer = null;
  renderStatus();
  renderList();
  hostCall(S.mode, { query: q, count: 10 }, function (err, res) {
    S.loading = false;
    if (err != null) {
      S.error = '' + err;
      S.results = [];
    } else if (res == null || res.ok === false) {
      S.error = (res && res.error) ? res.error : 'search failed';
      S.results = [];
    } else {
      S.error = null;
      S.results = res.results || [];
      S.answer = res.answer || null;
      S.provider = res.provider || null;
    }
    renderStatus();
    renderList();
  });
}

function openReader(entry) {
  S.reader = { url: entry.url, title: entry.title, text: null, loading: true, error: null };
  renderReader();
  hostCall('fetch', { url: entry.url }, function (err, res) {
    if (S.reader == null || S.reader.url !== entry.url) return;
    if (err != null) {
      S.reader.loading = false;
      S.reader.error = '' + err;
    } else if (res == null || res.ok === false) {
      S.reader.loading = false;
      S.reader.error = (res && res.error) ? res.error : 'could not read this page';
    } else {
      S.reader.loading = false;
      S.reader.title = res.title || entry.title;
      S.reader.text = res.text || '';
    }
    renderReader();
  });
}

function closeReader() {
  S.reader = null;
  renderReader();
}

// --------------------------------------------------------------------------- //
// UI                                                                           //
// --------------------------------------------------------------------------- //

var T = theme();

function tab(label, mode) {
  var active = S.mode === mode;
  var p = RN.pressable({
    onPress: function () { S.mode = mode; renderTabs(); runSearch(); },
    style: {
      paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
      backgroundColor: active ? T.accentSoft : 'transparent', marginRight: 6
    }
  });
  p.add(RN.text(label, { color: active ? T.accent : T.muted, fontSize: 13, fontWeight: '600' }));
  return p;
}

function build() {
  T = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: T.bg } });

  // Header + search box
  var header = RN.column({
    style: {
      paddingHorizontal: 14, paddingtop: 12, paddingVertical: 12,
      borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface
    }
  });
  header.add(RN.text('Web search', { color: T.text, fontSize: 16, fontWeight: '700', style: { marginBottom: 8 } }));

  var box = RN.row({ style: { alignItems: 'center' } });
  W.input = RN.input({
    placeholder: 'Search the web…',
    placeholderTextColor: T.muted,
    onChangeText: function (v) { S.query = v; },
    onSubmitEditing: runSearch,
    style: {
      flex: 1, color: T.text, backgroundColor: T.surfaceAlt, borderWidth: 1, borderColor: T.line,
      borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14
    }
  });
  box.add(W.input);
  var go = RN.pressable({
    onPress: runSearch,
    style: {
      marginLeft: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
      backgroundColor: T.accent
    }
  });
  go.add(RN.text('Search', { color: T.onAccent, fontSize: 13, fontWeight: '700' }));
  box.add(go);
  header.add(box);

  W.tabs = RN.row({ style: { marginTop: 10 } });
  header.add(W.tabs);
  root.add(header);
  renderTabs();

  // Status line
  W.status = RN.text('', { color: T.muted, fontSize: 12, style: { paddingHorizontal: 14, paddingTop: 8 } });
  root.add(W.status);

  // Results list
  W.list = RN.scroll({ style: { flex: 1, paddingHorizontal: 10, paddingTop: 4 } });
  root.add(W.list);

  // Reader overlay
  W.overlay = RN.view({ style: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } });
  W.overlay.set('pointerEvents', 'box-none');
  root.add(W.overlay);

  RN.mount(root);
  renderStatus();
  renderList();
}

function renderTabs() {
  if (W.tabs == null) return;
  W.tabs.clear();
  W.tabs.add(tab('Web', 'search'));
  W.tabs.add(tab('News', 'news'));
}

function renderStatus() {
  if (W.status == null) return;
  if (S.loading) {
    W.status.set('text', 'Searching…');
    W.status.set('color', T.muted);
  } else if (S.error != null) {
    W.status.set('text', '⚠ ' + S.error);
    W.status.set('color', T.danger);
  } else if (S.results.length > 0) {
    var n = S.results.length;
    W.status.set('text', n + (n === 1 ? ' result' : ' results') + (S.provider ? ' · ' + S.provider : ''));
    W.status.set('color', T.muted);
  } else {
    W.status.set('text', '');
  }
}

function resultHandler(entry) {
  return function () { openReader(entry); };
}

function linkHandler(url) {
  return function () { openUrl(url); };
}

function renderList() {
  if (W.list == null) return;
  W.list.clear();
  if (S.loading && S.results.length === 0) {
    W.list.add(RN.spinner({ color: T.accent, style: { marginTop: 24 } }));
    return;
  }
  if (S.error != null && S.results.length === 0) {
    var e = RN.column({ style: { alignItems: 'center', paddingTop: 32, paddingHorizontal: 20 } });
    e.add(RN.text('😕', { fontSize: 28 }));
    e.add(RN.text(S.error, { color: T.muted, fontSize: 13, textAlign: 'center', style: { marginTop: 8 } }));
    W.list.add(e);
    return;
  }
  if (S.results.length === 0) {
    var empty = RN.column({ style: { alignItems: 'center', paddingTop: 40 } });
    empty.add(RN.text('🔎', { fontSize: 28 }));
    empty.add(RN.text('Search the web to get started', { color: T.muted, fontSize: 13, style: { marginTop: 8 } }));
    W.list.add(empty);
    return;
  }
  // Synthesised answer card (when the provider returns one).
  if (S.answer != null && S.answer !== '') {
    var card = RN.column({
      style: {
        backgroundColor: T.accentSoft, borderRadius: 12, borderWidth: 1, borderColor: T.line,
        padding: 12, marginBottom: 10
      }
    });
    card.add(RN.text('Answer', { color: T.accent, fontSize: 12, fontWeight: '700', style: { marginBottom: 4 } }));
    card.add(RN.text(S.answer, { color: T.text, fontSize: 13 }));
    W.list.add(card);
  }
  var i = 0;
  while (i < S.results.length) {
    W.list.add(resultRow(S.results[i]));
    i = i + 1;
  }
  W.list.add(RN.view({ style: { height: 24 } }));
}

function resultRow(entry) {
  var row = RN.column({
    style: {
      paddingHorizontal: 12, paddingVertical: 11, marginBottom: 6, borderRadius: 10,
      backgroundColor: T.surface, borderWidth: 1, borderColor: T.line
    }
  });
  var titleP = RN.pressable({ onPress: resultHandler(entry) });
  titleP.add(RN.text(entry.title || entry.url, { color: T.link, fontSize: 14, fontWeight: '600' }));
  row.add(titleP);
  var meta = RN.row({ style: { alignItems: 'center', marginTop: 2 } });
  var hostP = RN.pressable({ onPress: linkHandler(entry.url) });
  hostP.add(RN.text(hostOfUrl(entry.url), { color: T.muted, fontSize: 11 }));
  meta.add(hostP);
  if (entry.published != null && entry.published !== '') {
    meta.add(RN.text('  ·  ' + entry.published, { color: T.muted, fontSize: 11 }));
  }
  row.add(meta);
  if (entry.snippet != null && entry.snippet !== '') {
    row.add(RN.text(entry.snippet, { color: T.text, fontSize: 12, style: { marginTop: 6 } }));
  }
  var actions = RN.row({ style: { marginTop: 8 } });
  var readBtn = RN.pressable({
    onPress: resultHandler(entry),
    style: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: T.surfaceAlt, marginRight: 6 }
  });
  readBtn.add(RN.text('Read', { color: T.text, fontSize: 12, fontWeight: '600' }));
  actions.add(readBtn);
  var openBtn = RN.pressable({
    onPress: linkHandler(entry.url),
    style: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: T.surfaceAlt }
  });
  openBtn.add(RN.text('Open ↗', { color: T.text, fontSize: 12, fontWeight: '600' }));
  actions.add(openBtn);
  row.add(actions);
  return row;
}

function renderReader() {
  if (W.overlay == null) return;
  W.overlay.clear();
  if (S.reader == null) {
    W.overlay.set('pointerEvents', 'box-none');
    return;
  }
  W.overlay.set('pointerEvents', 'auto');

  var scrim = RN.pressable({
    onPress: closeReader,
    style: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(2,6,20,0.6)' }
  });
  W.overlay.add(scrim);

  var cardOut = RN.column({
    style: {
      position: 'absolute', left: 12, right: 12, top: 24, bottom: 24,
      backgroundColor: T.surface, borderRadius: 14, borderWidth: 1, borderColor: T.line, overflow: 'hidden'
    }
  });
  var bar = RN.row({
    style: {
      alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12,
      borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surfaceAlt
    }
  });
  var nameCol = RN.column({ style: { flex: 1 } });
  nameCol.add(RN.text(S.reader.title || 'Reader', { color: T.text, fontSize: 14, fontWeight: '700' }));
  nameCol.add(RN.text(hostOfUrl(S.reader.url), { color: T.muted, fontSize: 11 }));
  bar.add(nameCol);
  var openB = RN.pressable({
    onPress: linkHandler(S.reader.url),
    style: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: T.bg, marginRight: 6 }
  });
  openB.add(RN.text('↗', { color: T.text, fontSize: 14 }));
  bar.add(openB);
  var closeB = RN.pressable({
    onPress: closeReader,
    style: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg }
  });
  closeB.add(RN.text('✕', { color: T.text, fontSize: 15 }));
  bar.add(closeB);
  cardOut.add(bar);

  var body = RN.scroll({ style: { flex: 1, padding: 14 } });
  if (S.reader.loading) {
    body.add(RN.spinner({ color: T.accent, style: { marginTop: 16 } }));
  } else if (S.reader.error != null) {
    body.add(RN.text(S.reader.error, { color: T.danger, fontSize: 13 }));
  } else {
    body.add(RN.text(S.reader.text || '(empty page)', { color: T.text, fontSize: 13 }));
  }
  cardOut.add(body);
  W.overlay.add(cardOut);
}

// --------------------------------------------------------------------------- //
// Compact widget (desktop grid)                                                //
// --------------------------------------------------------------------------- //

function isWidgetMode() {
  return ctx().mode === 'widget';
}

// A message-reply widget instance is seeded with __CTX.data (the tool's JSON
// answer for a chat command). We render that data as a compact card — an answer
// with its sources, a results list, or a readable fallback — so a chat command
// reply is a real widget, never raw JSON text. With no data we fall back to the
// "tap to search" preview card shown for a bare @tool mention.
function widgetHead(root, icon, title, sub) {
  var top = RN.row({ style: { alignItems: 'center', marginBottom: 8 } });
  top.add(RN.text(icon, { fontSize: 18, style: { marginRight: 8 } }));
  var col = RN.column({ style: { flex: 1 } });
  col.add(RN.text(title, { color: T.text, fontSize: 14, fontWeight: '700' }));
  if (sub != null && sub !== '') {
    col.add(RN.text(sub, { color: T.muted, fontSize: 11 }));
  }
  top.add(col);
  root.add(top);
}

function widgetSourceRow(s) {
  var url = (s != null && s.url != null) ? '' + s.url : '';
  var title = (s != null && s.title != null && s.title !== '') ? '' + s.title : url;
  var row = RN.pressable({
    onPress: linkHandler(url),
    style: { paddingVertical: 6, borderTopWidth: 1, borderTopColor: T.line }
  });
  row.add(RN.text(title, { color: T.link, fontSize: 12, fontWeight: '600' }));
  if (url !== '') row.add(RN.text(hostOfUrl(url), { color: T.muted, fontSize: 10 }));
  return row;
}

function widgetResultRow(r) {
  var url = (r != null && r.url != null) ? '' + r.url : '';
  var title = (r != null && r.title != null && r.title !== '') ? '' + r.title : url;
  var snip = '';
  if (r != null) {
    if (r.snippet != null && r.snippet !== '') snip = '' + r.snippet;
    else if (r.description != null && r.description !== '') snip = '' + r.description;
  }
  var row = RN.pressable({
    onPress: linkHandler(url),
    style: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: T.line }
  });
  row.add(RN.text(title, { color: T.text, fontSize: 13, fontWeight: '600' }));
  if (url !== '') row.add(RN.text(hostOfUrl(url), { color: T.link, fontSize: 10 }));
  if (snip !== '') row.add(RN.text(snip, { color: T.muted, fontSize: 11, style: { marginTop: 2 } }));
  return row;
}

// Render the client-computed `_view` (heading / sub / text / image / rows /
// details / note) — the canonical render-ready view the app builds from any tool
// reply. Used for the generic fallback and for replies (help, screenshots,
// scalar-only results) that have no native answer/results/sources shape.
function replyViewRow(row) {
  var url = (row != null && row.url != null) ? '' + row.url : '';
  var title = (row != null && row.title != null && row.title !== '') ? '' + row.title : (url !== '' ? url : 'item');
  var sub = (row != null && row.subtitle != null) ? '' + row.subtitle : '';
  var el;
  if (url !== '') {
    el = RN.pressable({ onPress: linkHandler(url), style: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: T.line } });
  } else {
    el = RN.column({ style: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: T.line } });
  }
  el.add(RN.text(title, { color: (url !== '' ? T.link : T.text), fontSize: 13, fontWeight: '600' }));
  if (url !== '') el.add(RN.text(hostOfUrl(url), { color: T.muted, fontSize: 10 }));
  if (sub !== '') el.add(RN.text(sub, { color: T.muted, fontSize: 11, style: { marginTop: 2 } }));
  return el;
}

function buildReplyWidgetView(view) {
  T = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: T.bg, padding: 12 } });
  var heading = (view != null && view.heading != null && view.heading !== '') ? '' + view.heading : 'Result';
  var sub = (view != null && view.sub != null) ? '' + view.sub : '';
  widgetHead(root, '🧩', heading, sub);
  var body = RN.scroll({ style: { flex: 1 } });
  var image = (view != null && view.image != null) ? '' + view.image : '';
  if (image !== '') {
    body.add(RN.image({ src: image, resizeMode: 'contain', style: { width: '100%', height: 320, backgroundColor: '#000', borderRadius: 8, marginBottom: 8 } }));
  }
  var text = (view != null && view.text != null) ? '' + view.text : '';
  if (text !== '') body.add(RN.text(text, { color: T.text, fontSize: 13 }));
  var rows = (view != null && view.rows != null) ? view.rows : null;
  if (rows != null) {
    var n = 0;
    while (n < rows.length && n < 20) { body.add(replyViewRow(rows[n])); n = n + 1; }
  }
  var details = (view != null && view.details != null) ? view.details : null;
  if (details != null) {
    var di = 0;
    while (di < details.length) {
      var d = details[di];
      var drow = RN.row({ style: { paddingVertical: 4, borderTopWidth: 1, borderTopColor: T.line } });
      drow.add(RN.text((d != null && d.label != null) ? '' + d.label : '', { color: T.muted, fontSize: 11, style: { width: 100 } }));
      drow.add(RN.text((d != null && d.value != null) ? '' + d.value : '', { color: T.text, fontSize: 12, style: { flex: 1 } }));
      body.add(drow);
      di = di + 1;
    }
  }
  var hasRows = rows != null && rows.length > 0;
  var hasDetails = details != null && details.length > 0;
  if (text === '' && image === '' && !hasRows && !hasDetails) {
    var note = (view != null && view.note != null && view.note !== '') ? '' + view.note : 'The tool returned no preview.';
    body.add(RN.text(note, { color: T.muted, fontSize: 12 }));
  } else if (view != null && view.note != null && view.note !== '') {
    body.add(RN.text('' + view.note, { color: T.muted, fontSize: 11, style: { marginTop: 6 } }));
  }
  root.add(body);
  RN.mount(root);
}

function buildDataWidget(data, command) {
  T = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: T.bg, padding: 12 } });
  var answer = (data != null && data.answer != null) ? '' + data.answer : '';
  var results = (data != null && data.results != null) ? data.results : null;
  var sources = (data != null && data.sources != null) ? data.sources : null;
  var query = (data != null && data.query != null) ? '' + data.query : '';

  if (answer !== '') {
    widgetHead(root, '💡', 'Answer', query);
    var ab = RN.scroll({ style: { flex: 1 } });
    ab.add(RN.text(answer, { color: T.text, fontSize: 13 }));
    if (sources != null && sources.length > 0) {
      ab.add(RN.text('Sources', {
        color: T.muted, fontSize: 11, fontWeight: '700', style: { marginTop: 10 }
      }));
      var i = 0;
      while (i < sources.length && i < 6) {
        ab.add(widgetSourceRow(sources[i]));
        i = i + 1;
      }
    }
    root.add(ab);
    RN.mount(root);
    return;
  }

  if (results != null && results.length > 0) {
    widgetHead(root, '🔎', 'Results', query);
    var rb = RN.scroll({ style: { flex: 1 } });
    var j = 0;
    while (j < results.length && j < 12) {
      rb.add(widgetResultRow(results[j]));
      j = j + 1;
    }
    root.add(rb);
    RN.mount(root);
    return;
  }

  // Readable fallback — prefer the client-computed `_view` (handles help,
  // screenshots, key/value scalar replies), else a text field or a short note.
  var view = (data != null && data._view != null) ? data._view : null;
  if (view != null) { buildReplyWidgetView(view); return; }
  var text = '';
  if (data != null) {
    if (data.text != null && data.text !== '') text = '' + data.text;
    else if (data.message != null && data.message !== '') text = '' + data.message;
  }
  widgetHead(root, '🧩', (command != null && command !== '') ? ('' + command) : 'Result', '');
  var gb = RN.scroll({ style: { flex: 1 } });
  gb.add(RN.text(text !== '' ? text : 'The tool returned data with no preview.', {
    color: text !== '' ? T.text : T.muted, fontSize: 12
  }));
  root.add(gb);
  RN.mount(root);
}

function buildWidget() {
  T = theme();
  var data = ctx().data;
  if (data != null) {
    buildDataWidget(data, ctx().command);
    return;
  }
  var root = RN.column({
    style: { flex: 1, backgroundColor: T.bg, padding: 12, justifyContent: 'space-between' }
  });
  var top = RN.row({ style: { alignItems: 'center' } });
  top.add(RN.text('🔎', { fontSize: 20, style: { marginRight: 8 } }));
  var titleCol = RN.column({ style: { flex: 1 } });
  titleCol.add(RN.text('Web search', { color: T.text, fontSize: 14, fontWeight: '700' }));
  titleCol.add(RN.text('search the internet', { color: T.muted, fontSize: 11 }));
  top.add(titleCol);
  root.add(top);
  root.add(RN.text('Tap to search', { color: T.muted, fontSize: 11 }));
  RN.mount(root);
}

// --------------------------------------------------------------------------- //
// Boot                                                                         //
// --------------------------------------------------------------------------- //

function main() {
  if (isWidgetMode()) {
    buildWidget();
    return;
  }
  build();
}

main();
