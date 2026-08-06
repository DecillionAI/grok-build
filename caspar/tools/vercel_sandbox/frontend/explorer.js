// vercel_sandbox — the tool's front-end (a Victor "mini app").
//
// This runs on the Elpian VM inside the Decillion client (the space "desktop"),
// NOT on the Caspar node. It is deployed as the downloadable `frontend` entity
// on the sandbox tool's own program, fetched at runtime by the client and run in
// the Victor React-Native host. It renders an interactive file explorer for the
// space's sandbox and reaches the sandbox back-end creature over the host bridge
// — every request is signed with the human user's identity by the host, never by
// this sandboxed guest.
//
// Wire to the host:
//   * `hostCall(fn, args, cb)` → askHost("host.call", …) → the client signs a
//     Caspar signal to THIS tool's back-end (`{ function: fn, payload: args }`)
//     as the logged-in user, and delivers the reply back via `__hostReply`.
//   * `__CTX` (injected by the client before this source) carries the theme, the
//     sandbox name and the starting path — no secrets, no identity.
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
// settles. Because each mini app is its own isolated VM, rid is purely our own
// correlation key.
//
// rid is a STRING, not a number, and that is load-bearing: the Elpian VM keys
// objects/maps by string only — assigning `__hostCbs[<int>]` traps the guest
// ("__setIndex expects a string, got i64") *before* the askHost below ever runs,
// so the file list would hang on "Loading…" forever. Coerce on the way in too,
// in case the host echoes the id back as a number.
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

// --------------------------------------------------------------------------- //
// Theme                                                                        //
// --------------------------------------------------------------------------- //

function ctx() {
  return (typeof __CTX !== 'undefined' && __CTX != null) ? __CTX : {};
}

function theme() {
  var t = ctx().theme;
  if (t == null) t = {};
  // Dark, Decillion-ish defaults; the host overrides with the live theme.
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
    danger: t.danger || '#f87171'
  };
}

// --------------------------------------------------------------------------- //
// Small helpers                                                                //
// --------------------------------------------------------------------------- //

// One decimal place without relying on Number.toFixed (unconfirmed in the VM).
function oneDecimal(v) {
  var scaled = Math.floor(v * 10 + 0.5);
  var whole = Math.floor(scaled / 10);
  var frac = scaled - whole * 10;
  return '' + whole + '.' + frac;
}

function humanSize(n) {
  if (n == null || n <= 0) return '';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = 0;
  var v = n;
  while (v >= 1024 && i < units.length - 1) {
    v = v / 1024;
    i = i + 1;
  }
  var s = (i === 0) ? ('' + v) : oneDecimal(v);
  return s + ' ' + units[i];
}

// Last index of a character, without String.lastIndexOf.
function lastIndexOfChar(s, ch) {
  var i = 0;
  var found = -1;
  while (i < s.length) {
    if (s.charAt(i) === ch) found = i;
    i = i + 1;
  }
  return found;
}

function extIcon(name, isDir) {
  if (isDir) return '📁';
  var dot = lastIndexOfChar(name, '.');
  var ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : '';
  if (ext === 'js' || ext === 'ts' || ext === 'tsx' || ext === 'jsx' || ext === 'json' || ext === 'py' ||
      ext === 'go' || ext === 'rs' || ext === 'java' || ext === 'c' || ext === 'cpp' || ext === 'sh') return '📜';
  if (ext === 'md' || ext === 'txt' || ext === 'log') return '📄';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'svg' || ext === 'webp') return '🖼️';
  if (ext === 'lock' || ext === 'toml' || ext === 'yaml' || ext === 'yml' || ext === 'env' || ext === 'cfg') return '⚙️';
  if (ext === 'zip' || ext === 'tar' || ext === 'gz' || ext === 'tgz') return '🗜️';
  return '📄';
}

// Path helpers built on push/slice only (no join/concat/split).
function joinPath(parts) {
  if (parts.length === 0) return '.';
  var out = '';
  var i = 0;
  while (i < parts.length) {
    out = out + (i === 0 ? '' : '/') + parts[i];
    i = i + 1;
  }
  return out;
}

// A copy of `arr` with `x` appended.
function appended(arr, x) {
  var next = arr.slice(0);
  next.push(x);
  return next;
}

// Split a slash path into non-empty segments (no String.split).
function splitSlash(s) {
  var out = [];
  var cur = '';
  var i = 0;
  while (i < s.length) {
    var ch = s.charAt(i);
    if (ch === '/') {
      if (cur !== '' && cur !== '.') out.push(cur);
      cur = '';
    } else {
      cur = cur + ch;
    }
    i = i + 1;
  }
  if (cur !== '' && cur !== '.') out.push(cur);
  return out;
}

// --------------------------------------------------------------------------- //
// State                                                                        //
// --------------------------------------------------------------------------- //

var S = {
  parts: [],        // path segments below the sandbox home dir
  entries: [],
  loading: false,
  error: null,
  preview: null     // { name, content, encoding }
};

// Retained widget handles we rebuild on state change.
var W = {};

// Retained handles for the compact desktop widget (widget mode only).
var WW = {};

// --------------------------------------------------------------------------- //
// Data                                                                         //
// --------------------------------------------------------------------------- //

function refresh() {
  S.loading = true;
  S.error = null;
  renderChrome();
  // Reflect the loading state in the list too (spinner on first load, old
  // contents kept during navigation), not just the status line.
  renderList();
  var path = joinPath(S.parts);
  hostCall('list_dir', { path: path }, function (err, res) {
    S.loading = false;
    if (err != null) {
      S.error = '' + err;
      S.entries = [];
    } else if (res == null || res.ok === false) {
      S.error = (res && res.error) ? res.error : 'could not read this folder';
      S.entries = [];
    } else {
      S.error = null;
      S.entries = res.entries || [];
    }
    renderChrome();
    renderList();
  });
}

function openDir(name) {
  S.parts = appended(S.parts, name);
  refresh();
}

function goUp() {
  if (S.parts.length === 0) return;
  S.parts = S.parts.slice(0, S.parts.length - 1);
  refresh();
}

function goToDepth(depth) {
  // depth 0 = home; otherwise keep the first `depth` segments.
  S.parts = S.parts.slice(0, depth);
  refresh();
}

function openFile(entry) {
  if (entry.size != null && entry.size > 512 * 1024) {
    S.preview = { name: entry.name, content: null, encoding: 'text', tooBig: true };
    renderPreview();
    return;
  }
  var path = joinPath(appended(S.parts, entry.name));
  S.preview = { name: entry.name, content: null, encoding: 'text', loading: true };
  renderPreview();
  hostCall('read', { path: path }, function (err, res) {
    if (err != null) {
      S.preview = { name: entry.name, content: 'Error: ' + err, encoding: 'text', error: true };
    } else if (res == null || res.ok === false) {
      S.preview = { name: entry.name, content: (res && res.error) ? res.error : 'could not read file', encoding: 'text', error: true };
    } else if (res.encoding === 'base64') {
      S.preview = { name: entry.name, content: '[binary file — ' + humanSize(res.bytes) + ']', encoding: 'base64' };
    } else {
      S.preview = { name: entry.name, content: res.content || '', encoding: 'text' };
    }
    renderPreview();
  });
}

function closePreview() {
  S.preview = null;
  renderPreview();
}

// --------------------------------------------------------------------------- //
// UI                                                                           //
// --------------------------------------------------------------------------- //

var T = theme();

function pill(label, onPress, active) {
  var p = RN.pressable({
    onPress: onPress,
    style: {
      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
      backgroundColor: active ? T.accentSoft : 'transparent',
      marginRight: 6
    }
  });
  p.add(RN.text(label, { color: active ? T.accent : T.muted, fontSize: 13, fontWeight: '600' }));
  return p;
}

function iconButton(glyph, onPress) {
  var b = RN.pressable({
    onPress: onPress,
    style: {
      width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
      backgroundColor: T.surfaceAlt, borderWidth: 1, borderColor: T.line, marginLeft: 6
    }
  });
  b.add(RN.text(glyph, { fontSize: 15, color: T.text }));
  return b;
}

// Build the static shell once; sections are patched in place afterwards.
function build() {
  T = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: T.bg } });

  // Header
  var header = RN.row({
    style: {
      alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12,
      borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface
    }
  });
  var titleCol = RN.column({ style: { flex: 1 } });
  titleCol.add(RN.text('Sandbox files', { color: T.text, fontSize: 16, fontWeight: '700' }));
  W.subtitle = RN.text(ctx().sandboxName || 'the space machine', { color: T.muted, fontSize: 12 });
  titleCol.add(W.subtitle);
  header.add(titleCol);
  header.add(iconButton('↑', goUp));
  header.add(iconButton('⟳', refresh));
  root.add(header);

  // Breadcrumbs
  W.crumbs = RN.scroll({
    horizontal: true,
    style: {
      maxHeight: 44, paddingHorizontal: 10, paddingVertical: 8,
      borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface
    }
  });
  root.add(W.crumbs);

  // Status line
  W.status = RN.text('', { color: T.muted, fontSize: 12, style: { paddingHorizontal: 14, paddingTop: 8 } });
  root.add(W.status);

  // List
  W.list = RN.scroll({ style: { flex: 1, paddingHorizontal: 8, paddingTop: 4 } });
  root.add(W.list);

  // Preview overlay host (filled on demand)
  W.overlay = RN.view({ style: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } });
  W.overlay.set('pointerEvents', 'box-none');
  root.add(W.overlay);

  RN.mount(root);
  renderChrome();
  renderList();
}

function renderChrome() {
  // Breadcrumbs: home / seg / seg …
  if (W.crumbs == null) return;
  W.crumbs.clear();
  W.crumbs.add(pill('🏠 home', function () { goToDepth(0); }, S.parts.length === 0));
  var i = 0;
  while (i < S.parts.length) {
    W.crumbs.add(RN.text('/', { color: T.muted, fontSize: 13, style: { marginRight: 6, alignSelf: 'center' } }));
    W.crumbs.add(pill(S.parts[i], depthHandler(i + 1), i === S.parts.length - 1));
    i = i + 1;
  }

  if (W.status != null) {
    if (S.loading) {
      // The very first open of a space boots a fresh cloud sandbox, which can
      // take up to a minute; deeper navigation is fast. Set expectations at the
      // root so a long first load doesn't read as "stuck".
      W.status.set('text', S.parts.length === 0 ? 'Starting sandbox… (first open can take a minute)' : 'Loading…');
      W.status.set('color', T.muted);
    } else if (S.error != null) {
      W.status.set('text', '⚠ ' + S.error);
      W.status.set('color', T.danger);
    } else {
      var n = S.entries.length;
      W.status.set('text', n + (n === 1 ? ' item' : ' items'));
      W.status.set('color', T.muted);
    }
  }
}

// Named factory so each breadcrumb closure captures its own depth (no var-loop
// capture bug).
function depthHandler(depth) {
  return function () { goToDepth(depth); };
}

function rowHandler(entry) {
  return function () {
    if (entry.type === 'dir') openDir(entry.name);
    else openFile(entry);
  };
}

function renderList() {
  if (W.list == null) return;
  W.list.clear();
  if (S.loading && S.entries.length === 0) {
    W.list.add(RN.spinner({ color: T.accent, style: { marginTop: 24 } }));
    return;
  }
  if (S.error != null && S.entries.length === 0) {
    var e = RN.column({ style: { alignItems: 'center', paddingTop: 32, paddingHorizontal: 20 } });
    e.add(RN.text('😕', { fontSize: 28 }));
    e.add(RN.text(S.error, { color: T.muted, fontSize: 13, textAlign: 'center', style: { marginTop: 8 } }));
    W.list.add(e);
    return;
  }
  if (S.entries.length === 0) {
    var empty = RN.column({ style: { alignItems: 'center', paddingTop: 32 } });
    empty.add(RN.text('📂', { fontSize: 28 }));
    empty.add(RN.text('This folder is empty', { color: T.muted, fontSize: 13, style: { marginTop: 8 } }));
    W.list.add(empty);
    return;
  }
  var i = 0;
  while (i < S.entries.length) {
    W.list.add(entryRow(S.entries[i]));
    i = i + 1;
  }
  // Bottom breathing room.
  W.list.add(RN.view({ style: { height: 24 } }));
}

function entryRow(entry) {
  var isDir = entry.type === 'dir';
  var row = RN.pressable({
    onPress: rowHandler(entry),
    style: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: 10, paddingVertical: 11, marginBottom: 4,
      borderRadius: 10, backgroundColor: T.surface, borderWidth: 1, borderColor: T.line
    }
  });
  row.add(RN.text(extIcon(entry.name, isDir), { fontSize: 18, style: { marginRight: 12, width: 24, textAlign: 'center' } }));
  var mid = RN.column({ style: { flex: 1 } });
  mid.add(RN.text(entry.name, { color: T.text, fontSize: 14, fontWeight: isDir ? '600' : '400' }));
  if (!isDir && entry.size != null && entry.size > 0) {
    mid.add(RN.text(humanSize(entry.size), { color: T.muted, fontSize: 11, style: { marginTop: 2 } }));
  }
  row.add(mid);
  row.add(RN.text(isDir ? '›' : '', { color: T.muted, fontSize: 18, style: { marginLeft: 8 } }));
  return row;
}

function renderPreview() {
  if (W.overlay == null) return;
  W.overlay.clear();
  if (S.preview == null) {
    W.overlay.set('pointerEvents', 'box-none');
    return;
  }
  W.overlay.set('pointerEvents', 'auto');

  // Scrim
  var scrim = RN.pressable({
    onPress: closePreview,
    style: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(2,6,20,0.55)' }
  });
  W.overlay.add(scrim);

  // Card
  var card = RN.column({
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
  nameCol.add(RN.text(S.preview.name, { color: T.text, fontSize: 14, fontWeight: '700' }));
  nameCol.add(RN.text(joinPath(S.parts) === '.' ? 'home' : joinPath(S.parts), { color: T.muted, fontSize: 11 }));
  bar.add(nameCol);
  bar.add(iconButton('✕', closePreview));
  card.add(bar);

  var body = RN.scroll({ style: { flex: 1, padding: 14 } });
  if (S.preview.loading) {
    body.add(RN.spinner({ color: T.accent, style: { marginTop: 16 } }));
  } else if (S.preview.tooBig) {
    body.add(RN.text('This file is large; open it from the sandbox shell instead.', { color: T.muted, fontSize: 13 }));
  } else {
    body.add(RN.text(S.preview.content || '', {
      color: S.preview.error ? T.danger : T.text,
      fontSize: 12,
      style: { fontFamily: 'Menlo' }
    }));
  }
  card.add(body);
  W.overlay.add(card);
}

// --------------------------------------------------------------------------- //
// Compact widget (desktop grid)                                                //
// --------------------------------------------------------------------------- //

// The client renders each tool as a square tile in the space "desktop" grid,
// running this same front-end but with `__CTX.mode === "widget"`. In that mode
// we draw a small stats card (folder/file counts for the sandbox home) instead
// of the full explorer; tapping the tile re-runs us in `mode === "single"`,
// which falls through to the full `build()` path below.
function isWidgetMode() {
  return ctx().mode === 'widget';
}

function buildWidget() {
  T = theme();
  var root = RN.column({
    style: { flex: 1, backgroundColor: T.bg, padding: 12, justifyContent: 'space-between' }
  });

  var top = RN.row({ style: { alignItems: 'center' } });
  top.add(RN.text('🗂️', { fontSize: 20, style: { marginRight: 8 } }));
  var titleCol = RN.column({ style: { flex: 1 } });
  titleCol.add(RN.text('Sandbox files', { color: T.text, fontSize: 14, fontWeight: '700' }));
  titleCol.add(RN.text(ctx().sandboxName || 'the space machine', { color: T.muted, fontSize: 11 }));
  top.add(titleCol);
  root.add(top);

  var statCol = RN.column({ style: { marginVertical: 8 } });
  WW.count = RN.text('—', { color: T.accent, fontSize: 30, fontWeight: '800' });
  statCol.add(WW.count);
  WW.label = RN.text('Loading…', { color: T.muted, fontSize: 12 });
  statCol.add(WW.label);
  root.add(statCol);

  root.add(RN.text('Tap to open', { color: T.muted, fontSize: 11 }));

  RN.mount(root);
  widgetRefresh();
}

function widgetRefresh() {
  hostCall('list_dir', { path: '.' }, function (err, res) {
    if (err != null || res == null || res.ok === false) {
      if (WW.count != null) WW.count.set('text', '—');
      if (WW.label != null) {
        WW.label.set('text', 'sandbox unavailable');
        WW.label.set('color', T.danger);
      }
      return;
    }
    var entries = res.entries || [];
    var dirs = 0;
    var files = 0;
    var i = 0;
    while (i < entries.length) {
      if (entries[i].type === 'dir') dirs = dirs + 1;
      else files = files + 1;
      i = i + 1;
    }
    if (WW.count != null) WW.count.set('text', '' + entries.length);
    if (WW.label != null) {
      WW.label.set(
        'text',
        dirs + (dirs === 1 ? ' folder' : ' folders') + ' · ' + files + (files === 1 ? ' file' : ' files')
      );
      WW.label.set('color', T.muted);
    }
  });
}

// --------------------------------------------------------------------------- //
// Boot                                                                         //
// --------------------------------------------------------------------------- //

function main() {
  if (isWidgetMode()) {
    buildWidget();
    return;
  }
  var start = ctx().startPath;
  if (typeof start === 'string' && start !== '' && start !== '.' && start !== '~') {
    // A relative start path below home.
    S.parts = splitSlash(start);
  }
  build();
  refresh();
}

main();
