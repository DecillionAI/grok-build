// computer — the tool's front-end (a Victor "mini app").
//
// Runs on the Elpian VM inside the Decillion client (the space "desktop"), NOT
// on the Caspar node. Deployed as the downloadable `frontend` entity on the
// computer tool's program, fetched at runtime and run in the Victor host.
//
// What it does: on open it asks its back-end creature to provision (or reuse) the
// space's graphical desktop, streams the install log while that happens, and — as
// soon as the desktop is ready — opens the live browser (the public VNC page) in
// Victor's in-app webview/iframe via the `host:openWebview` client capability, so
// the person interacts with the real browser using mouse / touch / keyboard.
//
// Wire to the host:
//   * `hostCall(fn, args, cb)` → askHost("host.call", …) → the client signs a
//     Caspar signal to THIS tool's back-end as the logged-in user; `host:` names
//     are client capabilities handled in the client (openWebview / openUrl).
//   * `__CTX` (injected before this source) carries theme + spaceId.
//
// No timers: the Victor guest VM has none, so the poll loop is a self-chaining
// hostCall — the back-end long-polls `status` (holding each call ~4s while the
// desktop is still installing), which paces the loop without a client timer.
//
// Conservative JS style (var, function expressions, no template literals) to stay
// comfortably inside js2elpian.

import 'reactnative.js';

// --------------------------------------------------------------------------- //
// Host bridge (guest side)                                                     //
// --------------------------------------------------------------------------- //

var __hostSeq = 0;
var __hostCbs = {};

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
// Context / theme                                                             //
// --------------------------------------------------------------------------- //

function ctx() {
  return (typeof __CTX !== 'undefined' && __CTX != null) ? __CTX : {};
}

function spaceId() {
  return '' + (ctx().spaceId || ctx().space_id || '');
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
    onAccent: t.onAccent || '#052e16',
    danger: t.danger || '#f87171'
  };
}

// --------------------------------------------------------------------------- //
// State                                                                        //
// --------------------------------------------------------------------------- //

var S = {
  phase: 'idle',       // idle | installing | ready | error
  url: '',
  installed: false,
  error: null,
  logs: [],            // accumulated install-log lines
  cursor: 0,
  polling: false,
  opened: false        // the webview has been opened for this url
};

var W = {};
var T = theme();

// --------------------------------------------------------------------------- //
// Back-end drive                                                               //
// --------------------------------------------------------------------------- //

function applySnapshot(res) {
  if (res == null) return;
  if (res.phase != null) S.phase = '' + res.phase;
  if (res.url != null) S.url = '' + res.url;
  if (res.installed != null) S.installed = !!res.installed;
  S.error = (res.error != null) ? ('' + res.error) : null;
  var lines = res.logs;
  if (lines != null && lines.length != null) {
    var i = 0;
    while (i < lines.length) { S.logs.push('' + lines[i]); i = i + 1; }
    if (S.logs.length > 400) S.logs = S.logs.slice(S.logs.length - 400);
  }
  if (res.cursor != null) S.cursor = res.cursor;
}

// The self-chaining poll loop. Each `status` call long-polls on the back-end
// (~4s while installing), so returning IS the pacing — we simply call again.
function poll() {
  if (S.polling) return;
  S.polling = true;
  hostCall('status', { space_id: spaceId(), cursor: S.cursor, wait: 4 }, function (err, res) {
    S.polling = false;
    if (err != null) {
      S.error = '' + err;
      renderView();
      return;
    }
    applySnapshot(res);
    renderView();
    if (S.phase === 'ready') {
      openWebview();
      return; // stop polling once the desktop is up
    }
    if (S.phase === 'error') return; // stop; the user can retry
    poll(); // keep streaming the install
  });
}

function openDesktop() {
  S.error = null;
  S.opened = false;
  S.phase = 'installing';
  renderView();
  hostCall('open', { space_id: spaceId(), cursor: S.cursor }, function (err, res) {
    if (err != null) {
      S.error = '' + err;
      S.phase = 'error';
      renderView();
      return;
    }
    applySnapshot(res);
    renderView();
    if (S.phase === 'ready') { openWebview(); return; }
    if (S.phase === 'error') return;
    poll();
  });
}

function restartDesktop() {
  S.logs = [];
  S.cursor = 0;
  S.url = '';
  S.opened = false;
  S.phase = 'installing';
  renderView();
  hostCall('restart', { space_id: spaceId() }, function (err, res) {
    if (err != null) { S.error = '' + err; S.phase = 'error'; renderView(); return; }
    applySnapshot(res);
    renderView();
    poll();
  });
}

// Open the live browser in Victor's in-app webview/iframe. `host:openWebview` is
// a client capability (see VictorDesktop.tsx): on web it layers an <iframe> over
// the desktop; elsewhere it falls back to the system browser.
function openWebview() {
  if (S.url === '') return;
  S.opened = true;
  hostCall('host:openWebview', { url: S.url, title: 'Computer' }, function () {});
  renderView();
}

function openInTab() {
  if (S.url === '') return;
  hostCall('host:openUrl', { url: S.url }, function () {});
}

// --------------------------------------------------------------------------- //
// UI                                                                           //
// --------------------------------------------------------------------------- //

function primaryButton(label, onPress) {
  var b = RN.pressable({
    onPress: onPress,
    style: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: T.accent }
  });
  b.add(RN.text(label, { color: T.onAccent, fontSize: 13, fontWeight: '700' }));
  return b;
}

function ghostButton(label, onPress) {
  var b = RN.pressable({
    onPress: onPress,
    style: {
      paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
      backgroundColor: T.surfaceAlt, borderWidth: 1, borderColor: T.line, marginLeft: 8
    }
  });
  b.add(RN.text(label, { color: T.text, fontSize: 13, fontWeight: '600' }));
  return b;
}

function phaseLabel() {
  if (S.phase === 'ready') return 'Ready';
  if (S.phase === 'installing') return S.installed ? 'Starting the desktop…' : 'Setting up the computer…';
  if (S.phase === 'error') return 'Setup failed';
  return 'Not started';
}

function build() {
  T = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: T.bg } });

  // Header
  var head = RN.row({
    style: {
      alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12,
      borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface
    }
  });
  head.add(RN.text('🖥️', { fontSize: 20, style: { marginRight: 10 } }));
  var htext = RN.column({ style: { flex: 1 } });
  htext.add(RN.text('Computer', { color: T.text, fontSize: 15, fontWeight: '700' }));
  W.phase = RN.text(phaseLabel(), { color: T.muted, fontSize: 12 });
  htext.add(W.phase);
  head.add(htext);
  root.add(head);

  // Body — either the install console or the ready panel.
  W.body = RN.scroll({ style: { flex: 1, backgroundColor: T.bg } });
  root.add(W.body);

  // Footer actions
  W.actions = RN.row({
    style: {
      alignItems: 'center', justifyContent: 'flex-end',
      paddingHorizontal: 12, paddingVertical: 10,
      borderTopWidth: 1, borderTopColor: T.line, backgroundColor: T.surface
    }
  });
  root.add(W.actions);

  RN.mount(root);
  renderView();
}

function renderActions() {
  if (W.actions == null) return;
  W.actions.clear();
  if (S.phase === 'ready') {
    W.actions.add(ghostButton('Open in new tab', openInTab));
    W.actions.add(RN.column({ style: { flex: 1 } }));
    W.actions.add(ghostButton('Restart', restartDesktop));
    W.actions.add(RN.column({ style: { width: 8 } }));
    W.actions.add(primaryButton('Open browser', openWebview));
  } else if (S.phase === 'error') {
    W.actions.add(RN.column({ style: { flex: 1 } }));
    W.actions.add(primaryButton('Try again', openDesktop));
  } else if (S.phase === 'installing') {
    W.actions.add(RN.text('Please wait — this runs once per space', { color: T.muted, fontSize: 11, style: { flex: 1 } }));
  } else {
    W.actions.add(RN.column({ style: { flex: 1 } }));
    W.actions.add(primaryButton('Open computer', openDesktop));
  }
}

function renderView() {
  if (W.phase != null) W.phase.set('text', phaseLabel());
  renderActions();
  if (W.body == null) return;
  W.body.clear();

  if (S.phase === 'ready') {
    var panel = RN.column({ style: { alignItems: 'center', padding: 20 } });
    panel.add(RN.text('🌐', { fontSize: 34, style: { marginTop: 12 } }));
    panel.add(RN.text('The computer is live', { color: T.text, fontSize: 15, fontWeight: '700', style: { marginTop: 10 } }));
    panel.add(RN.text(
      S.opened
        ? 'The browser is open above. Use your mouse, touch and keyboard to control it. Agents share the same screen.'
        : 'Tap "Open browser" to watch and control the live browser.',
      { color: T.muted, fontSize: 12, style: { marginTop: 6, textAlign: 'center' } }
    ));
    W.body.add(panel);
    return;
  }

  if (S.phase === 'error') {
    var err = RN.column({ style: { padding: 18 } });
    err.add(RN.text('⚠ Setup failed', { color: T.danger, fontSize: 14, fontWeight: '700' }));
    if (S.error != null) err.add(RN.text('' + S.error, { color: T.muted, fontSize: 12, style: { marginTop: 6 } }));
    err.add(RN.text('The install log is below.', { color: T.muted, fontSize: 11, style: { marginTop: 6 } }));
    W.body.add(err);
    W.body.add(logConsole());
    return;
  }

  if (S.phase === 'installing') {
    var head = RN.column({ style: { paddingHorizontal: 14, paddingTop: 14 } });
    head.add(RN.text('Setting up the computer for this space', { color: T.text, fontSize: 13, fontWeight: '600' }));
    head.add(RN.text('Installing the browser, VNC and a secure tunnel — the live log:', {
      color: T.muted, fontSize: 11, style: { marginTop: 4 }
    }));
    W.body.add(head);
    W.body.add(logConsole());
    return;
  }

  // idle
  var idle = RN.column({ style: { alignItems: 'center', padding: 24 } });
  idle.add(RN.text('🖥️', { fontSize: 34 }));
  idle.add(RN.text('A real browser for this space', { color: T.text, fontSize: 15, fontWeight: '700', style: { marginTop: 10 } }));
  idle.add(RN.text(
    'Open a graphical browser you and the agents share — you drive it with mouse, touch and keyboard.',
    { color: T.muted, fontSize: 12, style: { marginTop: 6, textAlign: 'center' } }
  ));
  W.body.add(idle);
}

function logConsole() {
  var box = RN.column({
    style: {
      margin: 12, padding: 10, borderRadius: 10,
      backgroundColor: '#05070d', borderWidth: 1, borderColor: T.line
    }
  });
  if (S.logs.length === 0) {
    box.add(RN.text('Starting…', { color: T.muted, fontSize: 11 }));
    return box;
  }
  var start = S.logs.length > 200 ? S.logs.length - 200 : 0;
  var i = start;
  while (i < S.logs.length) {
    box.add(RN.text('' + S.logs[i], { color: T.muted, fontSize: 11, style: { marginTop: 1 } }));
    i = i + 1;
  }
  return box;
}

// --------------------------------------------------------------------------- //
// Compact widget (desktop grid tile)                                           //
// --------------------------------------------------------------------------- //

function isWidgetMode() {
  return ctx().mode === 'widget';
}

function buildWidget() {
  T = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: T.bg, padding: 12, justifyContent: 'space-between' } });
  var top = RN.row({ style: { alignItems: 'center' } });
  top.add(RN.text('🖥️', { fontSize: 20, style: { marginRight: 8 } }));
  var col = RN.column({ style: { flex: 1 } });
  col.add(RN.text('Computer', { color: T.text, fontSize: 14, fontWeight: '700' }));
  col.add(RN.text('a live browser you control', { color: T.muted, fontSize: 11 }));
  top.add(col);
  root.add(top);
  root.add(RN.text('Tap to open', { color: T.muted, fontSize: 11 }));
  RN.mount(root);
}

// --------------------------------------------------------------------------- //
// Chat command reply widget (a @computer command answered as a widget)         //
// --------------------------------------------------------------------------- //

function buildReplyWidget(view) {
  var TT = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: TT.bg, padding: 12 } });
  var heading = (view != null && view.heading != null && view.heading !== '') ? '' + view.heading : 'Computer';
  var top = RN.row({ style: { alignItems: 'center', marginBottom: 8 } });
  top.add(RN.text('🖥️', { fontSize: 16, style: { marginRight: 8 } }));
  top.add(RN.text(heading, { color: TT.text, fontSize: 14, fontWeight: '700', style: { flex: 1 } }));
  root.add(top);
  var body = RN.scroll({ style: { flex: 1 } });
  var image = (view != null && view.image != null) ? '' + view.image : '';
  if (image !== '') {
    body.add(RN.image({ src: image, resizeMode: 'contain', style: { width: '100%', height: 320, backgroundColor: '#000', borderRadius: 8, marginBottom: 8 } }));
  }
  var text = (view != null && view.text != null) ? '' + view.text : '';
  if (text !== '') body.add(RN.text(text, { color: TT.text, fontSize: 13 }));
  var details = (view != null && view.details != null) ? view.details : null;
  if (details != null) {
    var di = 0;
    while (di < details.length) {
      var d = details[di];
      var drow = RN.row({ style: { paddingVertical: 4, borderTopWidth: 1, borderTopColor: TT.line } });
      drow.add(RN.text((d != null && d.label != null) ? '' + d.label : '', { color: TT.muted, fontSize: 11, style: { width: 90 } }));
      drow.add(RN.text((d != null && d.value != null) ? '' + d.value : '', { color: TT.text, fontSize: 12, style: { flex: 1 } }));
      body.add(drow);
      di = di + 1;
    }
  }
  if (text === '' && image === '' && (details == null || details.length === 0)) {
    var note = (view != null && view.note != null && view.note !== '') ? '' + view.note : 'Open the Computer tool on the space desktop.';
    body.add(RN.text(note, { color: TT.muted, fontSize: 12 }));
  } else if (view != null && view.note != null && view.note !== '') {
    body.add(RN.text('' + view.note, { color: TT.muted, fontSize: 11, style: { marginTop: 6 } }));
  }
  root.add(body);
  RN.mount(root);
}

// --------------------------------------------------------------------------- //
// Boot                                                                         //
// --------------------------------------------------------------------------- //

function main() {
  if (isWidgetMode()) {
    var reply = ctx().data;
    if (reply != null && reply._view != null) { buildReplyWidget(reply._view); return; }
    buildWidget();
    return;
  }
  build();
  // Auto-start: the moment the tool opens, provision or reuse the desktop and
  // stream the setup. Reopening a space where it is already up returns instantly.
  openDesktop();
}

main();
