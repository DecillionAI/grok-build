// github — the tool's front-end (a Victor "mini app").
//
// Runs on the Elpian VM inside the Decillion client (the space "desktop"), NOT
// on the Caspar node. Deployed as the downloadable `frontend` entity on the
// github tool's program, fetched at runtime and run in the Victor React-Native
// host. It renders the connect flow and the repository dashboard, and reaches
// the github back-end creature over the host bridge — every request is signed
// with the human user's identity by the host, never by this sandboxed guest.
//
// Wire to the host:
//   * hostCall(fn, args, cb) → askHost("host.call", …) → the client signs a
//     Caspar signal to THIS tool's back-end ({ function: fn, payload: args }) as
//     the logged-in user, and delivers the reply via __hostReply.
//   * hostCall("host:openUrl", { url }, cb) is a CLIENT capability, handled in
//     VictorDesktop (opens a browser tab) instead of the back-end — this is how
//     the GitHub authorization page is opened for the OAuth web flow.
//   * __CTX (injected by the client before this source) carries the theme and
//     the space id — no secrets, no identity.
//
// Conservative JS (var, function expressions, no template literals, no string[i]
// indexing) to stay comfortably inside js2elpian. Almost entirely button-driven
// and timer-free — the connect wait is server-paced (the back-end long-polls
// `oauth_wait`, so a "pending" reply just re-invokes). The one text input is the
// commit message on the Changes tab; it uses `defaultValue` so a full re-render
// (root.clear) restores what was typed from state (S.commitMsg).

import 'reactnative.js';

// --------------------------------------------------------------------------- //
// Host bridge (guest side)                                                     //
// --------------------------------------------------------------------------- //

var __hostSeq = 0;
var __hostCbs = {};

// The host invokes this with [rid, ok, data] when a host.call settles. rid is a
// STRING (the Elpian VM keys maps by string only).
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

var T = theme();

// --------------------------------------------------------------------------- //
// State                                                                        //
// --------------------------------------------------------------------------- //

var S = {
  view: 'loading',      // loading | connect | waiting | repos | repo | error
  error: null,
  busy: false,          // a foreground action is in flight
  conn: null,           // { connected, login, shared, is_owner, can_use, can_manage }
  auth: null,           // { authorize_url, state } for the in-flight connect
  authEpoch: 0,         // bumped when we leave the waiting view, to stop stale polls
  orgs: [],
  user: null,
  activeOrg: null,      // null = all accessible repos
  repos: [],
  reposLoading: false,
  repo: null,           // the open repo row
  tab: 'branches',      // branches | commits | pulls | changes
  detail: [],           // rows for the active tab
  detailLoading: false,
  cloned: {},           // full_name -> true (locally cloned in this space)
  changes: [],          // structured git_status rows for the Changes tab
  changesLoading: false,
  changesBranch: null,  // current branch, shown on the Changes tab
  commitMsg: '',        // the in-progress commit message (Changes tab input)
  toast: null,          // transient status line at the bottom
  settingsOpen: false
};

var ROOT = null;
var MOUNTED = false;

// --------------------------------------------------------------------------- //
// Small helpers                                                                //
// --------------------------------------------------------------------------- //

function oneDecimal(v) {
  var scaled = Math.floor(v * 10 + 0.5);
  var whole = Math.floor(scaled / 10);
  return '' + whole + '.' + (scaled - whole * 10);
}

function humanCount(n) {
  if (n == null) return '0';
  if (n < 1000) return '' + n;
  return oneDecimal(n / 1000) + 'k';
}

function toast(msg, isError) {
  S.toast = { text: msg, error: isError === true };
  render();
}

// First line of a string, without String.split (unconfirmed in the VM).
function firstLine(s) {
  s = '' + (s == null ? '' : s);
  var i = 0;
  while (i < s.length) {
    if (s.charAt(i) === '\n') return s.substring(0, i);
    i = i + 1;
  }
  return s;
}

// --------------------------------------------------------------------------- //
// Data actions                                                                 //
// --------------------------------------------------------------------------- //

function loadStatus() {
  S.view = 'loading';
  render();
  hostCall('status', {}, function (err, res) {
    if (err != null) {
      S.error = '' + err; S.view = 'error'; render(); return;
    }
    S.conn = res || {};
    if (res && res.connected) {
      enterDashboard();
    } else {
      S.view = 'connect';
      render();
    }
  });
}

function beginConnect() {
  S.busy = true; render();
  hostCall('oauth_start', {}, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false || res.authorize_url == null) {
      toast((res && res.error) ? res.error : ('could not start: ' + err), true);
      return;
    }
    S.auth = res;
    S.view = 'waiting';
    S.authEpoch = S.authEpoch + 1;
    render();
    openAuthPage();
    pollConnect(S.authEpoch);
  });
}

function openAuthPage() {
  if (S.auth == null || S.auth.authorize_url == null) return;
  hostCall('host:openUrl', { url: S.auth.authorize_url }, function () {});
}

// Server-paced wait: the back-end long-polls `oauth_wait` (blocks until the Nest
// callback stores the token), so on a "pending" reply we simply call again — no
// guest timer needed. `epoch` guards against a stale loop continuing after the
// user cancelled or connected.
function pollConnect(epoch) {
  if (epoch !== S.authEpoch) return;
  hostCall('oauth_wait', { wait: true }, function (err, res) {
    if (epoch !== S.authEpoch) return;
    if (err != null || res == null || res.ok === false) {
      S.error = (res && res.error) ? res.error : ('' + err);
      S.view = 'error';
      render();
      return;
    }
    if (res.connected === true || res.status === 'connected') {
      S.authEpoch = S.authEpoch + 1; // stop any further polls
      hostCall('status', {}, function (e2, st) {
        S.conn = (e2 == null && st) ? st : { connected: true, login: res.login, shared: res.shared, is_owner: true, can_use: true, can_manage: true };
        enterDashboard();
      });
      return;
    }
    if (res.status === 'expired') {
      S.authEpoch = S.authEpoch + 1;
      S.auth = null;
      S.view = 'connect';
      toast('the authorization timed out — try connecting again', true);
      return;
    }
    pollConnect(epoch); // still pending — go again (the call blocked server-side)
  });
}

function cancelConnect() {
  S.authEpoch = S.authEpoch + 1;
  S.auth = null;
  S.view = 'connect';
  render();
}

function enterDashboard() {
  S.view = 'repos';
  S.repo = null;
  render();
  loadOrgs();
  loadRepos(null);
}

function loadOrgs() {
  hostCall('orgs', {}, function (err, res) {
    if (err == null && res && res.ok !== false) {
      S.orgs = res.orgs || [];
      S.user = res.user || null;
      render();
    }
  });
}

function loadRepos(org) {
  S.activeOrg = org;
  S.reposLoading = true;
  S.repos = [];
  render();
  var payload = {};
  if (org != null) payload.org = org;
  hostCall('repos', payload, function (err, res) {
    S.reposLoading = false;
    if (err != null || res == null || res.ok === false) {
      toast((res && res.error) ? res.error : ('could not load repos: ' + err), true);
      S.repos = [];
    } else {
      S.repos = res.repos || [];
    }
    render();
  });
}

function openRepo(row) {
  S.repo = row;
  S.tab = 'branches';
  S.view = 'repo';
  render();
  loadDetail('branches');
  refreshCloned();
}

function refreshCloned() {
  hostCall('list_cloned', {}, function (err, res) {
    if (err == null && res && res.repos) {
      var map = {};
      var i = 0;
      while (i < res.repos.length) { map[res.repos[i].repo] = true; i = i + 1; }
      S.cloned = map;
      render();
    }
  });
}

function loadDetail(tab) {
  if (tab === 'changes') { loadChanges(); return; }
  S.tab = tab;
  S.detail = [];
  S.detailLoading = true;
  render();
  var fn = tab === 'commits' ? 'commits' : (tab === 'pulls' ? 'pulls' : 'branches');
  hostCall(fn, { repo: S.repo.full_name }, function (err, res) {
    S.detailLoading = false;
    if (err != null || res == null || res.ok === false) {
      toast((res && res.error) ? res.error : 'could not load', true);
      S.detail = [];
    } else {
      S.detail = res.branches || res.commits || res.pulls || [];
    }
    render();
  });
}

// The Changes tab: the clone's working-tree status (staged vs unstaged), with
// per-file stage/unstage and a commit box. Reads `git_status`, whose structured
// `files` carry a `staged`/`unstaged`/`untracked` breakdown.
function loadChanges() {
  S.tab = 'changes';
  S.changesLoading = true;
  render();
  hostCall('git_status', { repo: S.repo.full_name }, function (err, res) {
    S.changesLoading = false;
    if (err != null || res == null || res.ok === false) {
      toast((res && res.error) ? res.error : 'could not load changes', true);
      S.changes = [];
    } else {
      S.changes = res.files || [];
      S.changesBranch = res.branch || null;
    }
    render();
  });
}

function stagedList() {
  var out = [];
  var i = 0;
  while (i < S.changes.length) { if (S.changes[i].staged) out.push(S.changes[i]); i = i + 1; }
  return out;
}

function unstagedList() {
  var out = [];
  var i = 0;
  while (i < S.changes.length) { if (S.changes[i].unstaged) out.push(S.changes[i]); i = i + 1; }
  return out;
}

// path === null → act on everything (git add -A / git reset).
function stagePath(path) {
  S.busy = true; render();
  var payload = { repo: S.repo.full_name };
  if (path != null) payload.files = [path];
  hostCall('stage', payload, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      toast((res && res.error) ? res.error : 'stage failed', true);
      render();
    } else {
      if (res.files != null) { S.changes = res.files; S.changesBranch = res.branch || S.changesBranch; }
      toast(path != null ? ('staged ' + path) : 'staged all changes', false);
      render();
    }
  });
}

function unstagePath(path) {
  S.busy = true; render();
  var payload = { repo: S.repo.full_name };
  if (path != null) payload.files = [path];
  hostCall('unstage', payload, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      toast((res && res.error) ? res.error : 'unstage failed', true);
      render();
    } else {
      if (res.files != null) { S.changes = res.files; S.changesBranch = res.branch || S.changesBranch; }
      toast(path != null ? ('unstaged ' + path) : 'unstaged everything', false);
      render();
    }
  });
}

function commitStaged() {
  var msg = ('' + (S.commitMsg == null ? '' : S.commitMsg));
  // trim without String.trim ambiguity in the VM
  while (msg.length > 0 && (msg.charAt(0) === ' ' || msg.charAt(0) === '\n')) msg = msg.substring(1);
  while (msg.length > 0 && (msg.charAt(msg.length - 1) === ' ' || msg.charAt(msg.length - 1) === '\n')) msg = msg.substring(0, msg.length - 1);
  if (msg.length === 0) { toast('enter a commit message first', true); return; }
  if (stagedList().length === 0) { toast('stage some changes to commit', true); return; }
  S.busy = true; render();
  hostCall('commit', { repo: S.repo.full_name, message: msg, staged_only: true }, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      toast((res && (res.stderr || res.error)) ? (firstLine(res.stderr || res.error)) : 'commit failed', true);
      render();
    } else {
      S.commitMsg = '';
      toast('committed on ' + (S.changesBranch || 'this branch'), false);
      loadChanges();
    }
  });
}

function cloneRepo() {
  var full = S.repo.full_name;
  S.busy = true; render();
  hostCall('clone', { repo: full }, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      toast((res && res.error) ? res.error : 'clone failed', true);
    } else {
      S.cloned[full] = true;
      toast(res.cloned ? ('cloned ' + full) : ('fetched ' + full), false);
    }
    render();
  });
}

function gitAction(fn, label) {
  S.busy = true; render();
  hostCall(fn, { repo: S.repo.full_name }, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      toast((res && res.error) ? res.error : (label + ' failed'), true);
    } else {
      toast(label + ' done', false);
    }
    render();
  });
}

function mergePull(number) {
  S.busy = true; render();
  hostCall('merge_pull', { repo: S.repo.full_name, number: number }, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false || res.merged === false) {
      toast((res && (res.message || res.error)) ? (res.message || res.error) : 'merge failed', true);
    } else {
      toast('merged #' + number, false);
      loadDetail('pulls');
    }
    render();
  });
}

function openUrl(url) {
  if (url == null) return;
  hostCall('host:openUrl', { url: url }, function () {});
}

function setShared(next) {
  S.busy = true; render();
  hostCall('set_shared', { shared: next }, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      toast((res && res.error) ? res.error : 'could not change sharing', true);
    } else {
      S.conn.shared = res.shared;
      toast(res.shared ? 'shared with the space' : 'set to private', false);
    }
    render();
  });
}

function disconnect() {
  S.busy = true; render();
  hostCall('disconnect', {}, function (err, res) {
    S.busy = false;
    S.settingsOpen = false;
    if (err != null || res == null || res.ok === false) {
      toast((res && res.error) ? res.error : 'could not disconnect', true);
      render();
    } else {
      S.conn = { connected: false };
      S.repos = []; S.repo = null; S.orgs = [];
      S.view = 'connect';
      render();
    }
  });
}

// --------------------------------------------------------------------------- //
// UI primitives                                                                //
// --------------------------------------------------------------------------- //

function btn(label, onPress, kind) {
  var filled = kind === 'primary';
  var danger = kind === 'danger';
  var b = RN.pressable({
    onPress: onPress,
    style: {
      paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
      backgroundColor: filled ? T.accent : T.surfaceAlt,
      borderWidth: 1, borderColor: danger ? T.danger : (filled ? T.accent : T.line),
      alignItems: 'center', justifyContent: 'center', marginRight: 8
    }
  });
  b.add(RN.text(label, {
    color: filled ? T.onAccent : (danger ? T.danger : T.text),
    fontSize: 13, fontWeight: '700'
  }));
  return b;
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

function chip(label, onPress, active) {
  var p = RN.pressable({
    onPress: onPress,
    style: {
      paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
      backgroundColor: active ? T.accentSoft : T.surface,
      borderWidth: 1, borderColor: active ? T.accent : T.line, marginRight: 8
    }
  });
  p.add(RN.text(label, { color: active ? T.accent : T.muted, fontSize: 12, fontWeight: '600' }));
  return p;
}

function badge(label, color) {
  var v = RN.view({
    style: {
      paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
      backgroundColor: T.surfaceAlt, borderWidth: 1, borderColor: T.line, marginLeft: 6
    }
  });
  v.add(RN.text(label, { color: color || T.muted, fontSize: 10, fontWeight: '700' }));
  return v;
}

function header(title, subtitle, right) {
  var h = RN.row({
    style: {
      alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12,
      borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface
    }
  });
  if (right && right.back) {
    h.add(iconButton('‹', right.back));
  }
  var col = RN.column({ style: { flex: 1, marginLeft: (right && right.back) ? 8 : 0 } });
  col.add(RN.text(title, { color: T.text, fontSize: 16, fontWeight: '800' }));
  if (subtitle != null) col.add(RN.text(subtitle, { color: T.muted, fontSize: 12, style: { marginTop: 2 } }));
  h.add(col);
  if (right && right.gear) h.add(iconButton('⚙', right.gear));
  if (right && right.refresh) h.add(iconButton('⟳', right.refresh));
  return h;
}

function toastBar() {
  if (S.toast == null) return null;
  var v = RN.view({
    style: {
      paddingHorizontal: 14, paddingVertical: 9,
      backgroundColor: S.toast.error ? 'rgba(248,113,113,0.12)' : T.accentSoft,
      borderTopWidth: 1, borderTopColor: T.line
    }
  });
  v.add(RN.text((S.toast.error ? '⚠ ' : '✓ ') + S.toast.text, {
    color: S.toast.error ? T.danger : T.accent, fontSize: 12, fontWeight: '600'
  }));
  return v;
}

// --------------------------------------------------------------------------- //
// Views                                                                        //
// --------------------------------------------------------------------------- //

function viewLoading(root) {
  var c = RN.column({ style: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg } });
  c.add(RN.text('🐙', { fontSize: 34 }));
  c.add(RN.spinner({ color: T.accent, style: { marginTop: 14 } }));
  root.add(c);
}

function viewError(root) {
  root.add(header('GitHub', null, {}));
  var c = RN.column({ style: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: T.bg } });
  c.add(RN.text('😕', { fontSize: 30 }));
  c.add(RN.text(S.error || 'Something went wrong', { color: T.muted, fontSize: 13, textAlign: 'center', style: { marginTop: 10 } }));
  var row = RN.row({ style: { marginTop: 18 } });
  row.add(btn('Try again', loadStatus, 'primary'));
  c.add(row);
  root.add(c);
}

function viewConnect(root) {
  root.add(header('GitHub', 'Connect a GitHub account to this space', {}));
  var c = RN.column({ style: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26, backgroundColor: T.bg } });
  var hero = RN.view({
    style: {
      width: 72, height: 72, borderRadius: 20, backgroundColor: T.surface,
      borderWidth: 1, borderColor: T.line, alignItems: 'center', justifyContent: 'center'
    }
  });
  hero.add(RN.text('🐙', { fontSize: 38 }));
  c.add(hero);
  c.add(RN.text('Manage your organization', { color: T.text, fontSize: 19, fontWeight: '800', style: { marginTop: 18 } }));
  c.add(RN.text('Browse repositories and clone, commit, push, and open or merge pull requests — for you and your space’s agents.',
    { color: T.muted, fontSize: 13, textAlign: 'center', style: { marginTop: 8, maxWidth: 340 } }));
  var row = RN.row({ style: { marginTop: 22 } });
  if (S.busy) {
    row.add(RN.spinner({ color: T.accent }));
  } else {
    row.add(btn('Connect GitHub', beginConnect, 'primary'));
  }
  c.add(row);
  c.add(RN.text('Opens GitHub in a new tab. You choose which account and organizations to grant.',
    { color: T.muted, fontSize: 11, textAlign: 'center', style: { marginTop: 14, maxWidth: 320 } }));
  root.add(c);
}

function viewWaiting(root) {
  root.add(header('Authorize GitHub', 'Approve access in the GitHub tab', { back: cancelConnect }));
  var c = RN.column({ style: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26, backgroundColor: T.bg } });
  var hero = RN.view({
    style: {
      width: 72, height: 72, borderRadius: 20, backgroundColor: T.surface,
      borderWidth: 1, borderColor: T.line, alignItems: 'center', justifyContent: 'center'
    }
  });
  hero.add(RN.text('🐙', { fontSize: 38 }));
  c.add(hero);
  var waitRow = RN.row({ style: { marginTop: 22, alignItems: 'center' } });
  waitRow.add(RN.spinner({ color: T.accent }));
  waitRow.add(RN.text('Waiting for you to approve on GitHub…', { color: T.text, fontSize: 14, fontWeight: '600', style: { marginLeft: 10 } }));
  c.add(waitRow);
  c.add(RN.text('A GitHub tab opened for you. Choose the account and organizations to grant, then approve — this returns to your repositories automatically.',
    { color: T.muted, fontSize: 12, textAlign: 'center', style: { marginTop: 14, maxWidth: 340 } }));
  var row = RN.row({ style: { marginTop: 22 } });
  row.add(btn('Reopen GitHub', openAuthPage, 'primary'));
  row.add(btn('Cancel', cancelConnect, null));
  c.add(row);
  root.add(c);
}

function orgHandler(login) { return function () { loadRepos(login); }; }

function viewRepos(root) {
  var sub = S.conn && S.conn.login ? ('Connected as ' + S.conn.login + (S.conn.shared ? ' · shared' : ' · private')) : null;
  root.add(header('Repositories', sub, { gear: openSettings, refresh: function () { loadRepos(S.activeOrg); } }));

  // Org filter chips.
  var chips = RN.scroll({
    horizontal: true,
    style: { maxHeight: 48, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface }
  });
  chips.add(chip('All', function () { loadRepos(null); }, S.activeOrg == null));
  var i = 0;
  while (i < S.orgs.length) {
    chips.add(chip(S.orgs[i].login, orgHandler(S.orgs[i].login), S.activeOrg === S.orgs[i].login));
    i = i + 1;
  }
  root.add(chips);

  var list = RN.scroll({ style: { flex: 1, paddingHorizontal: 10, paddingTop: 8, backgroundColor: T.bg } });
  if (S.reposLoading) {
    list.add(RN.spinner({ color: T.accent, style: { marginTop: 24 } }));
  } else if (S.repos.length === 0) {
    var empty = RN.column({ style: { alignItems: 'center', paddingTop: 40 } });
    empty.add(RN.text('📦', { fontSize: 26 }));
    empty.add(RN.text('No repositories here', { color: T.muted, fontSize: 13, style: { marginTop: 8 } }));
    list.add(empty);
  } else {
    var j = 0;
    while (j < S.repos.length) {
      list.add(repoRow(S.repos[j]));
      j = j + 1;
    }
    list.add(RN.view({ style: { height: 24 } }));
  }
  root.add(list);
}

function repoRowHandler(row) { return function () { openRepo(row); }; }

function repoRow(row) {
  var p = RN.pressable({
    onPress: repoRowHandler(row),
    style: {
      flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12,
      marginBottom: 8, borderRadius: 12, backgroundColor: T.surface, borderWidth: 1, borderColor: T.line
    }
  });
  var mid = RN.column({ style: { flex: 1 } });
  var titleRow = RN.row({ style: { alignItems: 'center' } });
  titleRow.add(RN.text(row.private ? '🔒' : '📘', { fontSize: 14, style: { marginRight: 8 } }));
  titleRow.add(RN.text(row.name || row.full_name, { color: T.text, fontSize: 14, fontWeight: '700' }));
  if (S.cloned[row.full_name]) titleRow.add(badge('cloned', T.accent));
  mid.add(titleRow);
  if (row.description != null && row.description !== '') {
    mid.add(RN.text(row.description, { color: T.muted, fontSize: 12, style: { marginTop: 3 } }));
  }
  var meta = RN.row({ style: { marginTop: 6, alignItems: 'center' } });
  if (row.language != null) meta.add(RN.text(row.language, { color: T.muted, fontSize: 11, style: { marginRight: 12 } }));
  meta.add(RN.text('★ ' + humanCount(row.stars), { color: T.muted, fontSize: 11, style: { marginRight: 12 } }));
  meta.add(RN.text('⑃ ' + (row.default_branch || 'main'), { color: T.muted, fontSize: 11 }));
  mid.add(meta);
  p.add(mid);
  p.add(RN.text('›', { color: T.muted, fontSize: 20, style: { marginLeft: 8 } }));
  return p;
}

function tabHandler(tab) { return function () { loadDetail(tab); }; }

function viewRepo(root) {
  var r = S.repo;
  root.add(header(r.name || r.full_name, r.full_name, {
    back: function () { S.view = 'repos'; S.repo = null; render(); },
    refresh: function () { loadDetail(S.tab); }
  }));

  // Action bar: clone / pull / push / open on GitHub.
  var bar = RN.scroll({
    horizontal: true,
    style: { maxHeight: 58, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface }
  });
  if (S.busy) {
    bar.add(RN.spinner({ color: T.accent, style: { marginRight: 12 } }));
  }
  var isCloned = S.cloned[r.full_name] === true;
  if (!isCloned) {
    bar.add(btn('Clone to space', cloneRepo, 'primary'));
  } else {
    bar.add(btn('Pull', function () { gitAction('pull', 'pull'); }, null));
    bar.add(btn('Push', function () { gitAction('push', 'push'); }, null));
    bar.add(btn('Re-fetch', cloneRepo, null));
  }
  bar.add(btn('Open on GitHub', function () { openUrl('https://github.com/' + r.full_name); }, null));
  root.add(bar);

  // Tabs. The Changes tab (working-tree stage/commit) only applies once cloned.
  var tabs = RN.scroll({
    horizontal: true,
    style: { maxHeight: 46, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: T.bg }
  });
  tabs.add(chip('Branches', tabHandler('branches'), S.tab === 'branches'));
  tabs.add(chip('Commits', tabHandler('commits'), S.tab === 'commits'));
  tabs.add(chip('Pull requests', tabHandler('pulls'), S.tab === 'pulls'));
  if (isCloned) tabs.add(chip('Changes', tabHandler('changes'), S.tab === 'changes'));
  root.add(tabs);

  var list = RN.scroll({ style: { flex: 1, paddingHorizontal: 10, paddingTop: 4, backgroundColor: T.bg } });
  if (S.tab === 'changes') {
    changesView(list);
    root.add(list);
    return;
  }
  if (S.detailLoading) {
    list.add(RN.spinner({ color: T.accent, style: { marginTop: 22 } }));
  } else if (S.detail.length === 0) {
    var e = RN.column({ style: { alignItems: 'center', paddingTop: 34 } });
    e.add(RN.text('—', { color: T.muted, fontSize: 22 }));
    e.add(RN.text('Nothing to show', { color: T.muted, fontSize: 12, style: { marginTop: 6 } }));
    list.add(e);
  } else {
    var i = 0;
    while (i < S.detail.length) {
      if (S.tab === 'branches') list.add(branchRow(S.detail[i]));
      else if (S.tab === 'commits') list.add(commitRow(S.detail[i]));
      else list.add(pullRow(S.detail[i]));
      i = i + 1;
    }
    list.add(RN.view({ style: { height: 24 } }));
  }
  root.add(list);
}

// --------------------------------------------------------------------------- //
// Changes tab (stage / unstage / commit)                                       //
// --------------------------------------------------------------------------- //

function smallBtn(label, onPress, kind) {
  var danger = kind === 'danger';
  var b = RN.pressable({
    onPress: onPress,
    style: {
      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
      backgroundColor: T.surfaceAlt, borderWidth: 1, borderColor: danger ? T.danger : T.line, marginLeft: 8
    }
  });
  b.add(RN.text(label, { color: danger ? T.danger : T.text, fontSize: 12, fontWeight: '700' }));
  return b;
}

function sectionLabel(text) {
  return RN.text(text, { color: T.muted, fontSize: 11, fontWeight: '700', style: { marginTop: 10, marginBottom: 6, marginLeft: 2 } });
}

// A short, human status word for a file's XY porcelain code.
function changeWord(f) {
  if (f.untracked) return 'new';
  var c = (f.staged ? f.index : f.worktree) || f.index || f.worktree || '';
  if (c === 'M') return 'modified';
  if (c === 'A') return 'added';
  if (c === 'D') return 'deleted';
  if (c === 'R') return 'renamed';
  if (c === 'C') return 'copied';
  if (c === 'U') return 'conflict';
  return 'changed';
}

function stageHandler(path) { return function () { stagePath(path); }; }
function unstageHandler(path) { return function () { unstagePath(path); }; }

function changeFileRow(f, staged) {
  var card = rowCard();
  var row = RN.row({ style: { alignItems: 'center' } });
  row.add(RN.text(staged ? '●' : (f.untracked ? '✚' : '○'),
    { color: staged ? T.accent : T.muted, fontSize: 12, style: { marginRight: 10 } }));
  var col = RN.column({ style: { flex: 1 } });
  col.add(RN.text(f.path, { color: T.text, fontSize: 13, fontWeight: '600' }));
  col.add(RN.text(changeWord(f), { color: T.muted, fontSize: 11, style: { marginTop: 2 } }));
  row.add(col);
  if (S.busy) {
    // leave the buttons out while an action is in flight to avoid double-taps
  } else if (staged) {
    row.add(smallBtn('Unstage', unstageHandler(f.path)));
  } else {
    row.add(smallBtn('Stage', stageHandler(f.path)));
  }
  card.add(row);
  return card;
}

function commitBox() {
  var box = RN.column({
    style: {
      marginTop: 14, marginBottom: 8, padding: 12, borderRadius: 12,
      backgroundColor: T.surface, borderWidth: 1, borderColor: T.line
    }
  });
  var staged = stagedList();
  box.add(RN.text('Commit ' + staged.length + (staged.length === 1 ? ' staged change' : ' staged changes'),
    { color: T.text, fontSize: 13, fontWeight: '700' }));
  box.add(RN.input({
    placeholder: 'Commit message…',
    placeholderTextColor: T.muted,
    defaultValue: S.commitMsg,
    onChangeText: function (v) { S.commitMsg = v; },
    onSubmitEditing: commitStaged,
    style: {
      marginTop: 10, color: T.text, backgroundColor: T.surfaceAlt, borderWidth: 1, borderColor: T.line,
      borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 13
    }
  }));
  var row = RN.row({ style: { marginTop: 10, alignItems: 'center' } });
  if (S.busy) {
    row.add(RN.spinner({ color: T.accent }));
  } else {
    row.add(btn('Commit', commitStaged, staged.length > 0 ? 'primary' : null));
    row.add(btn('Push', function () { gitAction('push', 'push'); }, null));
  }
  box.add(row);
  return box;
}

function changesView(list) {
  if (S.changesLoading) {
    list.add(RN.spinner({ color: T.accent, style: { marginTop: 22 } }));
    return;
  }
  var head = RN.row({ style: { alignItems: 'center', paddingVertical: 6 } });
  head.add(RN.text('⑃ ' + (S.changesBranch || '—'), { color: T.muted, fontSize: 12, fontWeight: '700', style: { flex: 1 } }));
  head.add(iconButton('⟳', loadChanges));
  list.add(head);

  var staged = stagedList();
  var unstaged = unstagedList();

  if (staged.length === 0 && unstaged.length === 0) {
    var clean = RN.column({ style: { alignItems: 'center', paddingTop: 30 } });
    clean.add(RN.text('✓', { color: T.accent, fontSize: 26 }));
    clean.add(RN.text('Working tree clean', { color: T.muted, fontSize: 13, style: { marginTop: 8 } }));
    list.add(clean);
    list.add(RN.view({ style: { height: 24 } }));
    return;
  }

  // Staged section.
  var sHead = RN.row({ style: { alignItems: 'center' } });
  sHead.add(sectionLabel('Staged (' + staged.length + ')'));
  if (staged.length > 0 && !S.busy) {
    var sSpacer = RN.view({ style: { flex: 1 } }); sHead.add(sSpacer);
    sHead.add(smallBtn('Unstage all', function () { unstagePath(null); }));
  }
  list.add(sHead);
  if (staged.length === 0) {
    list.add(RN.text('Nothing staged yet', { color: T.muted, fontSize: 12, style: { marginLeft: 2, marginBottom: 4 } }));
  } else {
    var i = 0;
    while (i < staged.length) { list.add(changeFileRow(staged[i], true)); i = i + 1; }
  }

  // Unstaged / untracked section.
  var uHead = RN.row({ style: { alignItems: 'center' } });
  uHead.add(sectionLabel('Changes (' + unstaged.length + ')'));
  if (unstaged.length > 0 && !S.busy) {
    var uSpacer = RN.view({ style: { flex: 1 } }); uHead.add(uSpacer);
    uHead.add(smallBtn('Stage all', function () { stagePath(null); }));
  }
  list.add(uHead);
  if (unstaged.length === 0) {
    list.add(RN.text('No unstaged changes', { color: T.muted, fontSize: 12, style: { marginLeft: 2, marginBottom: 4 } }));
  } else {
    var j = 0;
    while (j < unstaged.length) { list.add(changeFileRow(unstaged[j], false)); j = j + 1; }
  }

  list.add(commitBox());
  list.add(RN.view({ style: { height: 24 } }));
}

function rowCard() {
  return RN.view({
    style: {
      paddingHorizontal: 12, paddingVertical: 11, marginBottom: 8, borderRadius: 10,
      backgroundColor: T.surface, borderWidth: 1, borderColor: T.line
    }
  });
}

function branchRow(b) {
  var card = rowCard();
  var row = RN.row({ style: { alignItems: 'center' } });
  row.add(RN.text('⑃', { color: T.accent, fontSize: 14, style: { marginRight: 10 } }));
  var col = RN.column({ style: { flex: 1 } });
  col.add(RN.text(b.name, { color: T.text, fontSize: 13, fontWeight: '600' }));
  if (b.sha != null) col.add(RN.text(('' + b.sha).substring(0, 10), { color: T.muted, fontSize: 11, style: { marginTop: 2, fontFamily: 'Menlo' } }));
  row.add(col);
  if (b.protected) row.add(badge('protected', T.muted));
  card.add(row);
  return card;
}

function commitRow(c) {
  var card = rowCard();
  card.add(RN.text(firstLine(c.message), { color: T.text, fontSize: 13, fontWeight: '600' }));
  var meta = RN.row({ style: { marginTop: 5, alignItems: 'center' } });
  meta.add(RN.text(('' + (c.sha || '')).substring(0, 8), { color: T.accent, fontSize: 11, style: { fontFamily: 'Menlo', marginRight: 10 } }));
  meta.add(RN.text((c.author || 'unknown') + ' · ' + (c.date || ''), { color: T.muted, fontSize: 11 }));
  card.add(meta);
  return card;
}

function pullMergeHandler(n) { return function () { mergePull(n); }; }
function pullOpenHandler(url) { return function () { openUrl(url); }; }

function pullRow(p) {
  var card = rowCard();
  var top = RN.row({ style: { alignItems: 'center' } });
  top.add(RN.text('#' + p.number, { color: T.muted, fontSize: 12, fontWeight: '700', style: { marginRight: 8 } }));
  top.add(RN.text(p.title || '', { color: T.text, fontSize: 13, fontWeight: '600', style: { flex: 1 } }));
  card.add(top);
  var meta = RN.row({ style: { marginTop: 5, alignItems: 'center' } });
  meta.add(RN.text((p.user || '') + ' · ' + (p.head || '') + ' → ' + (p.base || ''), { color: T.muted, fontSize: 11, style: { flex: 1 } }));
  if (p.draft) meta.add(badge('draft', T.muted));
  else if (p.merged) meta.add(badge('merged', T.accent));
  else meta.add(badge(p.state || 'open', T.accent));
  card.add(meta);

  var actions = RN.row({ style: { marginTop: 10 } });
  var canMerge = !p.merged && p.state === 'open' && S.conn && (S.conn.can_use !== false);
  if (canMerge) actions.add(btn('Merge', pullMergeHandler(p.number), 'primary'));
  actions.add(btn('View', pullOpenHandler(p.html_url), null));
  card.add(actions);
  return card;
}

// --------------------------------------------------------------------------- //
// Settings overlay                                                             //
// --------------------------------------------------------------------------- //

function openSettings() { S.settingsOpen = true; render(); }
function closeSettings() { S.settingsOpen = false; render(); }

function toggle(value, onPress) {
  var p = RN.pressable({
    onPress: onPress,
    style: {
      width: 48, height: 28, borderRadius: 999, padding: 3,
      backgroundColor: value ? T.accent : T.surfaceAlt, borderWidth: 1, borderColor: value ? T.accent : T.line,
      alignItems: value ? 'flex-end' : 'flex-start', justifyContent: 'center'
    }
  });
  p.add(RN.view({ style: { width: 20, height: 20, borderRadius: 999, backgroundColor: value ? T.onAccent : T.muted } }));
  return p;
}

function settingsOverlay(root) {
  if (!S.settingsOpen) return;
  var overlay = RN.view({ style: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } });
  overlay.add(RN.pressable({
    onPress: closeSettings,
    style: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(2,6,20,0.6)' }
  }));
  var card = RN.column({
    style: {
      position: 'absolute', left: 12, right: 12, bottom: 12, borderRadius: 16,
      backgroundColor: T.surface, borderWidth: 1, borderColor: T.line, overflow: 'hidden'
    }
  });
  var bar = RN.row({ style: { alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surfaceAlt } });
  var bc = RN.column({ style: { flex: 1 } });
  bc.add(RN.text('Connection settings', { color: T.text, fontSize: 15, fontWeight: '800' }));
  if (S.conn && S.conn.login) bc.add(RN.text('Connected as ' + S.conn.login, { color: T.muted, fontSize: 12, style: { marginTop: 2 } }));
  bar.add(bc);
  bar.add(iconButton('✕', closeSettings));
  card.add(bar);

  var body = RN.column({ style: { padding: 16 } });

  var isOwner = !S.conn || S.conn.can_manage !== false;
  // Shared toggle.
  var shareRow = RN.row({ style: { alignItems: 'center', paddingVertical: 10 } });
  var shareCol = RN.column({ style: { flex: 1 } });
  shareCol.add(RN.text('Share with the space', { color: T.text, fontSize: 14, fontWeight: '600' }));
  shareCol.add(RN.text('Let everyone in this space — people and agents — use this GitHub connection. Off means only you can.',
    { color: T.muted, fontSize: 12, style: { marginTop: 3, marginRight: 10 } }));
  shareRow.add(shareCol);
  var sharedNow = S.conn && S.conn.shared === true;
  if (isOwner && !S.busy) {
    shareRow.add(toggle(sharedNow, function () { setShared(!sharedNow); }));
  } else if (S.busy) {
    shareRow.add(RN.spinner({ color: T.accent }));
  } else {
    shareRow.add(badge(sharedNow ? 'shared' : 'private', T.muted));
  }
  body.add(shareRow);

  if (!isOwner) {
    body.add(RN.text('Only the member who connected GitHub can change these.', { color: T.muted, fontSize: 11, style: { marginTop: 4, marginBottom: 8 } }));
  }

  // Disconnect.
  if (isOwner) {
    var dRow = RN.row({ style: { marginTop: 14 } });
    dRow.add(btn('Disconnect GitHub', disconnect, 'danger'));
    body.add(dRow);
  }
  card.add(body);
  overlay.add(card);
  root.add(overlay);
}

// --------------------------------------------------------------------------- //
// Render                                                                       //
// --------------------------------------------------------------------------- //

function shell() {
  if (ROOT == null) ROOT = RN.column({ style: { flex: 1, backgroundColor: T.bg } });
  return ROOT;
}

function render() {
  T = theme();
  var root = shell();
  root.clear();
  if (S.view === 'loading') viewLoading(root);
  else if (S.view === 'error') viewError(root);
  else if (S.view === 'connect') viewConnect(root);
  else if (S.view === 'waiting') viewWaiting(root);
  else if (S.view === 'repo') viewRepo(root);
  else viewRepos(root);

  var tb = toastBar();
  if (tb != null) root.add(tb);
  settingsOverlay(root);

  if (!MOUNTED) { RN.mount(root); MOUNTED = true; }
}

// --------------------------------------------------------------------------- //
// Compact widget (desktop grid)                                                //
// --------------------------------------------------------------------------- //

var WW = {};

function isWidgetMode() { return ctx().mode === 'widget'; }

function buildWidget() {
  T = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: T.bg, padding: 12, justifyContent: 'space-between' } });
  var top = RN.row({ style: { alignItems: 'center' } });
  top.add(RN.text('🐙', { fontSize: 20, style: { marginRight: 8 } }));
  var tc = RN.column({ style: { flex: 1 } });
  tc.add(RN.text('GitHub', { color: T.text, fontSize: 14, fontWeight: '800' }));
  WW.sub = RN.text('Loading…', { color: T.muted, fontSize: 11 });
  tc.add(WW.sub);
  top.add(tc);
  root.add(top);

  var mid = RN.column({ style: { marginVertical: 8 } });
  WW.big = RN.text('—', { color: T.accent, fontSize: 26, fontWeight: '800' });
  mid.add(WW.big);
  WW.small = RN.text('', { color: T.muted, fontSize: 11 });
  mid.add(WW.small);
  root.add(mid);

  root.add(RN.text('Tap to open', { color: T.muted, fontSize: 11 }));
  RN.mount(root);

  hostCall('status', {}, function (err, res) {
    if (err != null || res == null) {
      if (WW.sub != null) { WW.sub.set('text', 'unavailable'); WW.sub.set('color', T.danger); }
      return;
    }
    if (res.connected) {
      if (WW.sub != null) WW.sub.set('text', res.shared ? 'shared' : 'private');
      if (WW.big != null) WW.big.set('text', '✓');
      if (WW.small != null) WW.small.set('text', res.login ? ('@' + res.login) : 'connected');
    } else {
      if (WW.sub != null) WW.sub.set('text', 'not connected');
      if (WW.big != null) { WW.big.set('text', '○'); WW.big.set('color', T.muted); }
      if (WW.small != null) WW.small.set('text', 'Tap to connect');
    }
  });
}

// --------------------------------------------------------------------------- //
// Boot                                                                         //
// --------------------------------------------------------------------------- //

// --------------------------------------------------------------------------- //
// Chat command reply widget                                                    //
// --------------------------------------------------------------------------- //
// A chat command reply reaches this front-end as __CTX.data._view — a
// render-ready view (heading / sub / text / rows / note) the client computed
// from this tool's JSON reply. We draw it so a command ALWAYS answers with a
// real widget, never raw JSON text. Self-contained: only hostCall + RN + theme().

function replyOpenUrl(url) {
  if (url == null || url === '') return;
  hostCall('host:openUrl', { url: '' + url }, function () {});
}

function replyHostOfUrl(url) {
  var s = '' + (url || '');
  var i = s.indexOf('://');
  if (i >= 0) s = s.substring(i + 3);
  var sl = s.indexOf('/');
  if (sl >= 0) s = s.substring(0, sl);
  return s;
}

function replyRow(TT, row) {
  var url = (row != null && row.url != null) ? '' + row.url : '';
  var title = (row != null && row.title != null && row.title !== '') ? '' + row.title : (url !== '' ? url : 'item');
  var sub = (row != null && row.subtitle != null) ? '' + row.subtitle : '';
  var el;
  if (url !== '') {
    el = RN.pressable({ onPress: function () { replyOpenUrl(url); }, style: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: TT.line } });
  } else {
    el = RN.column({ style: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: TT.line } });
  }
  el.add(RN.text(title, { color: (url !== '' ? TT.accent : TT.text), fontSize: 13, fontWeight: '600' }));
  if (url !== '') el.add(RN.text(replyHostOfUrl(url), { color: TT.muted, fontSize: 10 }));
  if (sub !== '') el.add(RN.text(sub, { color: TT.muted, fontSize: 11, style: { marginTop: 2 } }));
  return el;
}

function buildReplyWidget(view) {
  var TT = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: TT.bg, padding: 12 } });
  var heading = (view != null && view.heading != null && view.heading !== '') ? '' + view.heading : 'Result';
  var sub = (view != null && view.sub != null) ? '' + view.sub : '';
  var top = RN.row({ style: { alignItems: 'center', marginBottom: 8 } });
  top.add(RN.text('🧩', { fontSize: 16, style: { marginRight: 8 } }));
  var col = RN.column({ style: { flex: 1 } });
  col.add(RN.text(heading, { color: TT.text, fontSize: 14, fontWeight: '700' }));
  if (sub !== '') col.add(RN.text(sub, { color: TT.muted, fontSize: 11 }));
  top.add(col);
  root.add(top);
  var body = RN.scroll({ style: { flex: 1 } });
  var text = (view != null && view.text != null) ? '' + view.text : '';
  if (text !== '') body.add(RN.text(text, { color: TT.text, fontSize: 13 }));
  var rows = (view != null && view.rows != null) ? view.rows : null;
  if (rows != null) {
    var n = 0;
    while (n < rows.length && n < 20) { body.add(replyRow(TT, rows[n])); n = n + 1; }
  }
  if (text === '' && (rows == null || rows.length === 0)) {
    var note = (view != null && view.note != null && view.note !== '') ? '' + view.note : 'The tool returned no preview.';
    body.add(RN.text(note, { color: TT.muted, fontSize: 12 }));
  }
  root.add(body);
  RN.mount(root);
}

function main() {
  if (isWidgetMode()) {
    var __reply = ctx().data;
    if (__reply != null && __reply._view != null) { buildReplyWidget(__reply._view); return; }
    buildWidget();
    return;
  }
  render();      // paints the loading shell + mounts
  loadStatus();
}

main();
