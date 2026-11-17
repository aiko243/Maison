// =====================================================================
//  Maison — partage des tâches ménagères à deux
//  Connexion, vues semaine et mois, tâches, sauvegardes.
// =====================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, getDocs, getDocsFromServer, getDocFromServer,
  query, where, orderBy, limit, serverTimestamp, deleteField, FieldPath, writeBatch, Timestamp,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const APP_VERSION = '2.0.0';
const DATA_VERSION = 1;          // version du format des données (on ne fait qu'ajouter, jamais effacer)
const BACKUP_KEEP_DAYS = 35;     // copies en ligne conservées ~5 semaines
const MAX_BACKUP_CHARS = 900000; // limite Firestore : 1 Mo par document
const COLORS = ['#E2557F', '#7A68DB', '#24A07F', '#E5862E', '#3384D6', '#B8932A'];

// ---------- État ----------
const S = {
  uid: null,
  members: {},          // uid -> { name, color }
  membersReady: false,
  tasks: new Map(),     // id -> tâche
  weekStart: mondayOf(new Date()),
  view: 'home',         // l'app s'ouvre toujours sur l'accueil
  notes: new Map(),     // notes partagées et rappels
  actions: null,        // liste des actions (icône + nom), null = liste par défaut
  pend: {},             // écritures en attente, par liste
  monthStart: firstOfMonth(new Date()),
  selDay: ymd(new Date()),   // jour sélectionné dans la vue mois
  online: navigator.onLine,
  synced: false,        // données reçues du serveur
  snapPending: false,   // modifications pas encore confirmées par le serveur
  writing: 0,           // écritures en cours
  lastSaved: null,
  error: null,
  editing: null,        // tâche en cours de modification
  lastBackupAt: null,
};
let auth, db;
let unsubs = [];

// ---------- Petits outils ----------
const $ = (s) => document.querySelector(s);
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'vars') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); }
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fWeekday = new Intl.DateTimeFormat('fr-FR', { weekday: 'long' });
const fDayMonth = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const fFull = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const fTime = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
function fmtRange(start) {
  const end = addDays(start, 6);
  if (start.getMonth() === end.getMonth()) {
    return `${start.getDate()} – ${end.getDate()} ${new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(end)}`;
  }
  return `${fDayMonth.format(start)} – ${fDayMonth.format(end)}`;
}
function toMillis(v) {
  if (v instanceof Timestamp) return v.toMillis();
  if (typeof v === 'number') return v;
  return null;
}
// Convertit les données Firestore en JSON simple (dates -> nombres)
function plain(v) {
  if (v instanceof Timestamp) return v.toMillis();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = plain(x); return o; }
  return v;
}

// ---------- Écrans ----------
const SCREENS = ['loading', 'config', 'login', 'denied', 'profile', 'main'];
function show(name) {
  for (const s of SCREENS) $(`#screen-${s}`).hidden = s !== name;
}

// ---------- Thème ----------
function themePref() { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } }
function isDark() {
  const p = themePref();
  return p === 'dark' || (p === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'auto') delete root.dataset.theme; else root.dataset.theme = pref;
  try { localStorage.setItem('theme', pref); } catch { /* rien */ }
  // En mode « auto », on force l'attribut selon le téléphone pour que les icônes suivent
  $('meta[name="theme-color"]').setAttribute('content', isDark() ? '#141316' : '#FAF9F7');
  renderThemeSeg();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(themePref()));

// ---------- Messages ----------
let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  $('#toast-text').textContent = msg;
  const btn = $('#toast-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { t.hidden = true; action.run(); };
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 3500);
}
function confirmDialog(title, text, okLabel = 'OK', danger = false, infoOnly = false) {
  return new Promise((resolve) => {
    const d = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    const ok = $('#confirm-ok');
    ok.textContent = okLabel;
    ok.classList.toggle('danger-bg', danger);
    $('#confirm-cancel').hidden = infoOnly;
    const done = (v) => { d.close(); resolve(v); };
    ok.onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    d.oncancel = () => resolve(false);
    d.showModal();
  });
}

// ---------- Statut : en ligne / sauvegardé ----------
function track(promise) {
  S.writing++;
  renderStatus();
  return promise
    .then(() => { S.lastSaved = new Date(); S.error = null; })
    .catch((e) => {
      console.error(e);
      S.error = e;
      toast(e?.code === 'permission-denied'
        ? 'Modification refusée par la sécurité. Rien d\'autre n\'est perdu.'
        : 'L\'enregistrement a échoué. Réessaie.');
    })
    .finally(() => { S.writing--; renderStatus(); });
}
function renderStatus() {
  const el = $('#status');
  if (!el) return;
  const pending = S.writing > 0 || S.snapPending;
  let state, text;
  if (S.error) { state = 'error'; text = 'Échec de l\'enregistrement'; }
  else if (!S.online && pending) { state = 'pending'; text = 'Hors ligne · en attente d\'envoi'; }
  else if (!S.online) { state = 'offline'; text = 'Hors ligne'; }
  else if (pending) { state = 'pending'; text = 'Enregistrement…'; }
  else if (!S.synced) { state = 'offline'; text = 'Connexion…'; }
  else { state = 'ok'; text = S.lastSaved ? `Sauvegardé à ${fTime.format(S.lastSaved)}` : 'À jour'; }
  el.dataset.state = state;
  $('#status-text').textContent = text;
}
function statusDetails() {
  const lines = [];
  lines.push(S.online ? 'Connecté à internet.' : 'Pas de connexion : tes modifications sont gardées sur ce téléphone et partiront toutes seules au retour du réseau.');
  if (S.lastSaved) lines.push(`Dernier enregistrement en ligne : ${fTime.format(S.lastSaved)}.`);
  if (S.lastBackupAt) lines.push(`Copie du jour : faite (${fFull.format(S.lastBackupAt)}).`);
  if (S.error) lines.push(`Dernière erreur : ${S.error.code || S.error.message}.`);
  confirmDialog('État de la sauvegarde', lines.join('\n\n'), 'OK', false, true).then(() => {
    S.error = null; renderStatus();
  });
}
window.addEventListener('online', () => { S.online = true; renderStatus(); });
window.addEventListener('offline', () => { S.online = false; renderStatus(); });

// =====================================================================
//  Démarrage
// =====================================================================
function isConfigured() {
  return firebaseConfig && typeof firebaseConfig.apiKey === 'string' && !firebaseConfig.apiKey.includes('A_REMPLIR');
}

function start() {
  bindUi();
  applyTheme(themePref());
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (!isConfigured()) { show('config'); return; }

  const app = initializeApp(firebaseConfig);
  // Session gardée sur l'appareil (pas besoin de se reconnecter chaque jour)
  auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  // Cache local : l'app marche hors ligne et renvoie tout dès le retour du réseau
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

  onAuthStateChanged(auth, (user) => { if (user) onLogin(user); else onLogout(); });
}

function onLogout() {
  unsubs.forEach((u) => u()); unsubs = [];
  Object.assign(S, { uid: null, members: {}, membersReady: false, tasks: new Map(), notes: new Map(), actions: null, pend: {}, synced: false, lastBackupAt: null, view: 'home' });
  mainStarted = false;
  $('#login-password').value = '';
  show('login');
}

function onLogin(user) {
  S.uid = user.uid;
  show('loading');
  $('#loading-text').textContent = 'Connexion…';

  unsubs.push(onSnapshot(collection(db, 'members'), { includeMetadataChanges: true }, (snap) => {
    const m = {};
    snap.forEach((d) => { const x = d.data(); m[d.id] = { name: x.name, color: x.color }; });
    S.members = m;
    const decided = snap.metadata.fromCache === false || m[S.uid];
    if (!S.membersReady && decided) {
      S.membersReady = true;
      if (m[S.uid]) enterMain(); else openProfileScreen();
    } else if (S.membersReady) {
      if (!$('#screen-main').hidden) render();
      if (!$('#screen-profile').hidden) renderProfileColors('#profile-colors', $('#profile-colors').dataset.value);
    }
  }, onListenError));
}

// Notes et actions : si les règles de sécurité n'ont pas encore été mises à jour,
// le reste de l'app continue de marcher et on prévient une seule fois.
let rulesWarned = false;
function softListenError(e) {
  console.error(e);
  if (e.code === 'permission-denied' && !rulesWarned) {
    rulesWarned = true;
    confirmDialog('Règles de sécurité à mettre à jour',
      'Les notes, rappels et actions partagées ont besoin des nouvelles règles de sécurité. Copie le fichier firestore.rules du dépôt dans Firebase (Firestore → Règles), avec vos deux UID, puis Publier.',
      'OK', false, true);
  }
}

function onListenError(e) {
  console.error(e);
  if (e.code === 'permission-denied') { unsubs.forEach((u) => u()); unsubs = []; show('denied'); }
  else toast('Problème de connexion aux données. Réessaie plus tard.');
}

// ---------- Profil (prénom + couleur) ----------
function otherUid() { return Object.keys(S.members).find((u) => u !== S.uid) || null; }

function renderProfileColors(sel, current) {
  const box = $(sel);
  const taken = S.members[otherUid()]?.color;
  box.dataset.value = current || '';
  box.replaceChildren(...COLORS.map((c) => h('button', {
    type: 'button', class: 'swatch', role: 'radio', vars: { '--c': c },
    'aria-checked': String(c === current), 'aria-label': `Couleur ${c}`,
    disabled: c === taken && c !== current,
    onclick: () => {
      renderProfileColors(sel, c);
      if (sel === '#menu-colors') saveProfile(null, c);
    },
  })));
}

function openProfileScreen() {
  const taken = S.members[otherUid()]?.color;
  renderProfileColors('#profile-colors', COLORS.find((c) => c !== taken));
  show('profile');
  setTimeout(() => $('#profile-name').focus(), 50);
}

function saveProfile(name, color) {
  const me = S.members[S.uid] || {};
  const data = {
    name: (name ?? me.name ?? '').trim().slice(0, 30),
    color: color ?? me.color ?? COLORS[0],
    updatedAt: serverTimestamp(),
  };
  if (!data.name) return;
  S.members[S.uid] = { name: data.name, color: data.color };
  track(setDoc(doc(db, 'members', S.uid), data));
  if (!$('#screen-main').hidden) render();
}

// =====================================================================
//  Écran principal
// =====================================================================
let mainStarted = false;
function enterMain() {
  show('main');
  render();
  renderStatus();
  if (mainStarted) return;
  mainStarted = true;

  // Suit l'état « en attente d'envoi » de chaque liste pour l'indicateur de sauvegarde
  const onMeta = (key, meta) => {
    const wasPending = S.snapPending;
    S.pend[key] = meta.hasPendingWrites;
    S.snapPending = Object.values(S.pend).some(Boolean);
    if (key === 'tasks') S.synced = !meta.fromCache;
    if (wasPending && !S.snapPending && S.synced) S.lastSaved = new Date();
  };

  unsubs.push(onSnapshot(
    query(collection(db, 'tasks'), where('deleted', '==', false)),
    { includeMetadataChanges: true },
    (snap) => {
      S.tasks = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
      onMeta('tasks', snap.metadata);
      render();
      renderStatus();
      if (S.synced) dailyBackup();
    },
    onListenError,
  ));
  unsubs.push(onSnapshot(
    query(collection(db, 'notes'), where('deleted', '==', false)),
    { includeMetadataChanges: true },
    (snap) => {
      S.notes = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
      onMeta('notes', snap.metadata);
      if (S.view === 'home') renderHome();
      renderStatus();
    },
    softListenError,
  ));
  unsubs.push(onSnapshot(doc(db, 'config', 'actions'), { includeMetadataChanges: true }, (snap) => {
    const items = snap.exists() ? snap.data().items : null;
    S.actions = Array.isArray(items) ? items.filter((a) => a && typeof a.e === 'string' && typeof a.label === 'string') : null;
    onMeta('config', snap.metadata);
    if ($('#actions-dialog').open) renderActionsManager();
    if ($('#task-sheet').open) renderEmojiPicker();
    renderStatus();
  }, softListenError));
}

function render() {
  renderLegend();
  renderView();
}

// ---------- Vue semaine / vue mois ----------
function renderView() {
  const v = S.view;
  $('#home').hidden = v !== 'home';
  $('#week').hidden = v !== 'week';
  $('#month').hidden = v !== 'month';
  $('#legend').hidden = v === 'home';
  for (const name of ['home', 'week', 'month']) $(`#view-${name}`).setAttribute('aria-pressed', String(v === name));
  $('#prev-btn').hidden = $('#next-btn').hidden = v === 'home';
  $('#prev-btn').setAttribute('aria-label', v === 'month' ? 'Mois précédent' : 'Semaine précédente');
  $('#next-btn').setAttribute('aria-label', v === 'month' ? 'Mois suivant' : 'Semaine suivante');
  if (v === 'home') renderHome();
  else if (v === 'month') renderMonth();
  else renderWeek();
}

function setView(v) {
  if (v === S.view) return;
  // Entre semaine et mois, on garde le même moment ; depuis l'accueil, on part d'aujourd'hui
  const today = new Date();
  if (S.view === 'home') {
    S.weekStart = mondayOf(today); S.monthStart = firstOfMonth(today); S.selDay = ymd(today);
  } else if (v === 'month') {
    const inWeek = ymd(mondayOf(today)) === ymd(S.weekStart);
    const ref = inWeek ? today : S.weekStart;
    S.monthStart = firstOfMonth(ref);
    S.selDay = ymd(ref);
  } else if (v === 'week') {
    S.weekStart = mondayOf(parseYmd(S.selDay));
  }
  S.view = v;
  window.scrollTo(0, 0);
  renderView();
}

function goStep(n) {
  if (S.view === 'month') {
    S.monthStart = addMonths(S.monthStart, n);
    const today = new Date();
    S.selDay = ymd(firstOfMonth(today).getTime() === S.monthStart.getTime() ? today : S.monthStart);
  } else {
    S.weekStart = addDays(S.weekStart, 7 * n);
  }
  renderView();
}

function goToday() {
  const today = new Date();
  S.weekStart = mondayOf(today);
  S.monthStart = firstOfMonth(today);
  S.selDay = ymd(today);
  renderView();
}

// Tâches regroupées par jour, entre deux dates
function tasksByDay(from, to) {
  const byDay = new Map();
  for (const t of S.tasks.values()) {
    for (const d of occurrences(t, from, to)) {
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(t);
    }
  }
  for (const [ds, list] of byDay) {
    list.sort((a, b) => {
      const da = isDone(a, ds), dbb = isDone(b, ds);
      if (da !== dbb) return da ? 1 : -1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  }
  return byDay;
}

const fMonthOnly = new Intl.DateTimeFormat('fr-FR', { month: 'long' });
const fMonthShort = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: 'numeric' });
const WEEKDAY_LETTERS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

function renderMonth() {
  const first = S.monthStart;
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const gridStart = mondayOf(first);
  const gridEnd = addDays(mondayOf(last), 6);
  const today = ymd(new Date());
  const byDay = tasksByDay(ymd(gridStart), ymd(gridEnd));

  // L'année n'est affichée que si ce n'est pas l'année en cours (titre court sur téléphone)
  $('#period').textContent = cap(first.getFullYear() === new Date().getFullYear()
    ? fMonthOnly.format(first) : fMonthShort.format(first));
  $('#today-btn').hidden = first.getTime() === firstOfMonth(new Date()).getTime() && S.selDay === today;

  const cells = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) {
    const ds = ymd(d);
    const list = byDay.get(ds) || [];
    const out = d.getMonth() !== first.getMonth();
    const shown = list.slice(0, 4);
    const doneCount = list.filter((t) => isDone(t, ds)).length;
    cells.push(h('button', {
      type: 'button',
      class: `mcell${out ? ' is-out' : ''}${ds === today ? ' is-now' : ''}${ds === S.selDay ? ' is-sel' : ''}${ds < today ? ' is-past' : ''}`,
      'aria-label': `${fFull.format(d)} : ${list.length ? `${list.length} tâche${list.length > 1 ? 's' : ''}, ${doneCount} faite${doneCount > 1 ? 's' : ''}` : 'rien de prévu'}`,
      'aria-pressed': String(ds === S.selDay),
      onclick: () => {
        S.selDay = ds;
        if (out) S.monthStart = firstOfMonth(d);
        renderMonth();
      },
    },
    h('span', { class: 'mnum', text: d.getDate() }),
    list.length ? h('span', { class: 'mdots', 'aria-hidden': 'true' },
      shown.map((t) => h('i', { class: `mdot${t.assignee === 'both' ? ' both' : ''}${isDone(t, ds) ? ' done' : ''}`, vars: whoVars(t.assignee) })),
      list.length > shown.length ? h('span', { class: 'mmore', text: `+${list.length - shown.length}` }) : null) : null));
  }

  // Détail du jour sélectionné, sous le calendrier
  const sel = parseYmd(S.selDay);
  const selList = byDay.get(S.selDay) || [];
  const detail = h('section', { class: 'day month-detail' },
    h('button', {
      type: 'button', class: 'day-head',
      'aria-label': `Ajouter une tâche ${fWeekday.format(sel)} ${fDayMonth.format(sel)}`,
      onclick: () => openTask(null, S.selDay),
    },
    h('span', { class: 'dname', text: cap(fWeekday.format(sel)) }),
    h('span', { class: 'ddate', text: fDayMonth.format(sel) }),
    h('span', { class: 'dadd', 'aria-hidden': 'true', text: '+' })),
    selList.length
      ? h('ul', { class: 'tasks' }, selList.map((t) => taskRow(t, S.selDay)))
      : h('p', { class: 'empty', text: 'Rien de prévu ce jour-là.' }));

  $('#month').replaceChildren(
    h('div', { class: 'mweek', 'aria-hidden': 'true' }, WEEKDAY_LETTERS.map((l) => h('span', { text: l }))),
    h('div', { class: 'mgrid' }, cells),
    detail,
  );
}

function colorOf(uid) { return S.members[uid]?.color || '#9A97A1'; }
function nameOf(uid) { return S.members[uid]?.name || '…'; }
function orderedUids() {
  const o = otherUid();
  return o ? [S.uid, o] : [S.uid];
}
function whoVars(assignee) {
  if (assignee === 'both') {
    const [a, b] = orderedUids();
    return { '--c1': colorOf(a), '--c2': colorOf(b || a), '--c': colorOf(a) };
  }
  return { '--c': colorOf(assignee) };
}
function whoLabel(assignee) { return assignee === 'both' ? 'Nous deux' : nameOf(assignee); }

function renderLegend() {
  const uids = orderedUids();
  $('#legend').replaceChildren(...uids.map((u) => h('span', {}, h('i', { vars: whoVars(u) }), nameOf(u))));
}

// Jours où une tâche apparaît dans [from, to] (prêt pour les tâches récurrentes)
function occurrences(t, from, to) {
  return t.date >= from && t.date <= to ? [t.date] : [];
}

function renderWeek() {
  const start = S.weekStart;
  const from = ymd(start), to = ymd(addDays(start, 6));
  const today = ymd(new Date());
  $('#period').textContent = fmtRange(start);
  $('#today-btn').hidden = from === ymd(mondayOf(new Date()));

  const byDay = tasksByDay(from, to);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const ds = ymd(date);
    const list = byDay.get(ds) || [];
    days.push(h('section', { class: `day${ds === today ? ' is-today' : ''}${ds < today ? ' is-past' : ''}` },
      h('button', {
        type: 'button', class: 'day-head',
        'aria-label': `Ajouter une tâche ${fWeekday.format(date)} ${fDayMonth.format(date)}`,
        onclick: () => openTask(null, ds),
      },
      h('span', { class: 'dname', text: cap(fWeekday.format(date)) }),
      h('span', { class: 'ddate', text: fDayMonth.format(date) }),
      h('span', { class: 'dadd', 'aria-hidden': 'true', text: '+' })),
      list.length ? h('ul', { class: 'tasks' }, list.map((t) => taskRow(t, ds))) : null));
  }
  $('#week').replaceChildren(...days);
}

function isDone(t, ds) { return !!(t.completions && t.completions[ds]); }

// Une ligne de tâche. opts.side remplace le nom affiché à droite (ex. la date pour « En retard »)
function taskRow(t, ds, opts = {}) {
  const done = isDone(t, ds);
  const { emoji, text } = splitTitle(t.title);
  const comment = typeof t.comment === 'string' ? t.comment.trim() : '';
  return h('li', { class: `task${done ? ' is-done' : ''}` },
    h('button', {
      type: 'button', class: `check${t.assignee === 'both' ? ' both' : ''}`, role: 'checkbox',
      vars: whoVars(t.assignee), 'aria-checked': String(done),
      'aria-label': `${text} : ${done ? 'fait' : 'à faire'}`,
      onclick: () => toggleDone(t, ds),
    }),
    h('button', { type: 'button', class: 'task-main', onclick: () => openTask(t) },
      emoji ? h('span', { class: 'task-emoji', 'aria-hidden': 'true', text: emoji }) : null,
      h('span', { class: 'task-text' },
        h('span', { class: 'task-title', text }),
        comment ? h('span', { class: 'task-comment', text: comment }) : null),
      h('span', { class: 'task-who', text: opts.side ?? whoLabel(t.assignee) })));
}

// ---------- Actions sur les tâches ----------
function toggleDone(t, ds) {
  const done = isDone(t, ds);
  const value = done ? deleteField() : { by: S.uid, at: Date.now() };
  // Affichage immédiat, l'enregistrement suit (même hors ligne)
  t.completions = { ...(t.completions || {}) };
  if (done) delete t.completions[ds]; else t.completions[ds] = value;
  renderView();
  if (!done) celebrateIfAllDone(ds);
  track(updateDoc(doc(db, 'tasks', t.id),
    new FieldPath('completions', ds), value,
    'updatedAt', serverTimestamp(),
    'updatedBy', S.uid));
}

function renderWho(selected) {
  const options = [...orderedUids().map((u) => ({ v: u, label: nameOf(u) })), { v: 'both', label: 'Nous deux' }];
  $('#task-who').replaceChildren(...options.map((o) => h('label', {},
    h('input', { type: 'radio', name: 'who', value: o.v, checked: o.v === selected }),
    h('span', {}, h('i', { class: o.v === 'both' ? 'both' : null, vars: whoVars(o.v) }), o.label))));
}

// ---------- Actions (icône + nom) ----------
// Liste par défaut : uniquement le ménage de l'appartement, des plus fréquentes aux plus rares.
// Elle est partagée et modifiable (Réglages → Actions) : ajout, suppression, changement de rang.
const DEFAULT_ACTIONS = [
  { e: '🍽️', label: 'Vaisselle' },
  { e: '🧽', label: 'Plan de travail' },
  { e: '🚰', label: 'Évier' },
  { e: '🍳', label: 'Plaques de cuisson' },
  { e: '🗑️', label: 'Poubelles' },
  { e: '🧹', label: 'Aspirateur' },
  { e: '🪶', label: 'Poussière' },
  { e: '🧺', label: 'Linge' },
  { e: '♻️', label: 'Tri' },
  { e: '🧼', label: 'Cuisine' },
  { e: '♨️', label: 'Micro-ondes' },
  { e: '🚽', label: 'Toilettes' },
  { e: '🛁', label: 'Salle de bain' },
  { e: '🪣', label: 'Serpillière' },
  { e: '🛏️', label: 'Draps' },
  { e: '👕', label: 'Repassage' },
  { e: '🔥', label: 'Four' },
  { e: '🧊', label: 'Frigo' },
  { e: '📦', label: 'Rangement' },
  { e: '🪟', label: 'Vitres' },
];
// Mots reconnus pour deviner l'icône en tapant le nom (les plus précis d'abord)
const KEYWORDS = [
  ['♨️', ['micro-onde', 'micro onde', 'microonde']],
  ['🔥', ['four']],
  ['🍳', ['plaque', 'plaques de cuisson', 'gaziniere', 'hotte', 'induction']],
  ['🚰', ['evier', 'robinet']],
  ['🧽', ['plan de travail', 'plans de travail', 'eponge', 'table']],
  ['🧊', ['frigo', 'refrigerateur', 'congelateur', 'degivrer']],
  ['🍽️', ['vaisselle', 'assiette', 'lave-vaisselle']],
  ['🗑️', ['poubelle', 'ordure', 'dechet']],
  ['♻️', ['tri', 'recyclage', 'recycler', 'verre', 'carton']],
  ['🪶', ['poussiere', 'depoussierer', 'plumeau']],
  ['🧹', ['aspirateur', 'aspirer', 'balai', 'balayer']],
  ['🪣', ['serpillere', 'serpilliere', 'laver le sol', 'sol']],
  ['🧺', ['linge', 'lessive', 'machine', 'etendre', 'plier', 'seche-linge']],
  ['👕', ['repassage', 'repasser']],
  ['🛏️', ['lit', 'drap', 'housse', 'couette']],
  ['🚽', ['toilette', 'wc']],
  ['🛁', ['salle de bain', 'sdb', 'douche', 'baignoire', 'lavabo', 'bain']],
  ['🪟', ['vitre', 'fenetre', 'miroir']],
  ['📦', ['rangement', 'ranger', 'placard', 'armoire']],
  ['🧼', ['cuisine', 'nettoyer', 'nettoyage', 'menage']],
];
const EMOJI_RE = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*/u;
const ONE_EMOJI_RE = /^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u;

function actions() { return S.actions && S.actions.length ? S.actions : DEFAULT_ACTIONS; }

function splitTitle(title) {
  const m = (title || '').match(EMOJI_RE);
  return m ? { emoji: m[1], text: title.slice(m[0].length) } : { emoji: '', text: title || '' };
}

const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function hasWord(norm, kw) {
  // Mot entier (avec pluriel en -s ou -x) : « sol » ne reconnaît pas « solde »
  const k = normalize(kw).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${k}[sx]?(?![a-z])`).test(norm);
}
const STOP = new Set(['les', 'des', 'une', 'pour', 'avec', 'dans', 'sur', 'faire', 'passer', 'laver', 'nettoyer']);

function suggestEmoji(text) {
  const norm = normalize(text);
  if (!norm.trim()) return '';
  const labelMatch = (a) => normalize(a.label).split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w)).some((w) => hasWord(norm, w));
  const defaults = new Set(DEFAULT_ACTIONS.map((a) => normalize(a.label)));
  // 1. Actions ajoutées par vous : prioritaires, on cherche les mots de leur nom
  for (const a of actions()) if (!defaults.has(normalize(a.label)) && labelMatch(a)) return a.e;
  // 2. Mots-clés connus pour les actions de départ
  const available = new Set(actions().map((a) => a.e));
  for (const [e, kws] of KEYWORDS) {
    if (available.has(e) && kws.some((kw) => hasWord(norm, kw))) return e;
  }
  // 3. Nom des autres actions
  for (const a of actions()) if (labelMatch(a)) return a.e;
  return '';
}

function renderEmojiPicker() {
  $('#task-emoji').replaceChildren(...actions().map((a) => h('button', {
    type: 'button', role: 'radio', class: 'action-btn',
    'aria-checked': String(a.e === S.pickedEmoji), 'aria-label': a.label,
    onclick: () => pickAction(a),
  }, h('span', { class: 'action-emoji', text: a.e }), h('span', { class: 'action-label', text: a.label }))));
}

function pickAction(a) {
  const input = $('#task-title');
  const current = input.value.trim();
  if (S.pickedEmoji === a.e) {
    S.pickedEmoji = '';
    if (current === S.autoTitle) { input.value = ''; S.autoTitle = ''; }
  } else {
    S.pickedEmoji = a.e;
    // Nom vide (ou rempli par une autre action) : on met le nom de l'action
    if (!current || current === S.autoTitle) { input.value = a.label; S.autoTitle = a.label; }
  }
  S.emojiManual = true;
  renderEmojiPicker();
}

function openTask(t, dateStr) {
  S.editing = t;
  $('#task-sheet-title').textContent = t ? 'Modifier la tâche' : 'Nouvelle tâche';
  const parts = splitTitle(t ? t.title : '');
  $('#task-title').value = parts.text;
  $('#task-comment').value = t && typeof t.comment === 'string' ? t.comment : '';
  S.pickedEmoji = parts.emoji;
  S.emojiManual = !!parts.emoji;   // une icône déjà choisie n'est plus devinée automatiquement
  S.autoTitle = '';
  renderEmojiPicker();
  $('#task-emoji').scrollLeft = 0;
  $('#task-date').value = t ? t.date : (dateStr || ymd(new Date()));
  renderWho(t ? t.assignee : S.uid);
  $('#task-delete').hidden = !t;
  $('#task-error').hidden = true;
  $('#task-sheet').showModal();
}

function saveTask(e) {
  e.preventDefault();
  const text = $('#task-title').value.trim().slice(0, 80);
  // L'icône est enregistrée au début du titre
  const title = text && S.pickedEmoji ? `${S.pickedEmoji} ${text}` : text;
  const comment = $('#task-comment').value.trim().slice(0, 500);
  const date = $('#task-date').value;
  const assignee = document.querySelector('input[name="who"]:checked')?.value || S.uid;
  const err = $('#task-error');
  if (!title) { err.textContent = 'Donne un nom à la tâche, ou choisis une action.'; err.hidden = false; return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { err.textContent = 'Choisis un jour.'; err.hidden = false; return; }

  const t = S.editing;
  if (t) {
    track(updateDoc(doc(db, 'tasks', t.id), {
      title, date, assignee, comment, updatedAt: serverTimestamp(), updatedBy: S.uid,
    }));
  } else {
    const ref = doc(collection(db, 'tasks'));
    track(setDoc(ref, {
      title, date, assignee, comment,
      completions: {}, repeat: null, deleted: false,
      createdBy: S.uid, createdAt: Date.now(),
      updatedAt: serverTimestamp(), updatedBy: S.uid,
      v: DATA_VERSION,
    }));
  }
  $('#task-sheet').close();
  // Le calendrier se place sur le jour de la tâche (l'accueil reste l'accueil)
  S.weekStart = mondayOf(parseYmd(date));
  S.monthStart = firstOfMonth(parseYmd(date));
  S.selDay = date;
  renderView();
  if (S.view === 'home' && date !== ymd(new Date())) toast(`Tâche ajoutée pour ${fFull.format(parseYmd(date))}`);
}

// ---------- Gestion des actions (Réglages) ----------
function saveActions(items) {
  S.actions = items;
  track(setDoc(doc(db, 'config', 'actions'), { items, updatedAt: serverTimestamp(), updatedBy: S.uid }));
  renderActionsManager();
}

function renderActionsManager() {
  const list = actions();
  $('#actions-list').replaceChildren(...list.map((a, i) => h('li', {},
    h('span', { class: 'act-rank', text: i + 1 }),
    h('span', { class: 'act-emoji', text: a.e }),
    h('span', { class: 'act-label', text: a.label }),
    h('button', {
      type: 'button', class: 'icon-btn small', 'aria-label': `Monter ${a.label}`, disabled: i === 0,
      onclick: () => { const l = [...list]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; saveActions(l); },
    }, svgArrow('up')),
    h('button', {
      type: 'button', class: 'icon-btn small', 'aria-label': `Descendre ${a.label}`, disabled: i === list.length - 1,
      onclick: () => { const l = [...list]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; saveActions(l); },
    }, svgArrow('down')),
    h('button', {
      type: 'button', class: 'icon-btn small danger', 'aria-label': `Retirer ${a.label}`,
      onclick: () => {
        const l = list.filter((_, j) => j !== i);
        saveActions(l);
        toast(`« ${a.label} » retirée`, { label: 'Annuler', run: () => saveActions(list) });
      },
    }, svgArrow('x')))));
  // Rang proposé pour une nouvelle action
  const sel = $('#act-rank');
  const keep = sel.value;
  sel.replaceChildren(...Array.from({ length: list.length + 1 }, (_, i) => h('option', { value: i, text: i === list.length ? `${i + 1} (en dernier)` : String(i + 1) })));
  sel.value = keep !== '' && Number(keep) <= list.length ? keep : String(list.length);
}

function svgArrow(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', kind === 'up' ? 'M6 15l6-6 6 6' : kind === 'down' ? 'M6 9l6 6 6-6' : 'M7 7l10 10M17 7L7 17');
  p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

function addAction(e) {
  e.preventDefault();
  const err = $('#act-error');
  const emoji = $('#act-emoji').value.trim();
  const label = $('#act-label').value.trim().slice(0, 30);
  const rank = Number($('#act-rank').value);
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  err.hidden = true;
  if (!ONE_EMOJI_RE.test(emoji)) return fail('Mets un seul emoji (avec le clavier emoji du téléphone).');
  if (!label) return fail('Donne un nom à l\'action.');
  const list = actions();
  if (list.some((a) => normalize(a.label) === normalize(label))) return fail('Cette action existe déjà.');
  if (list.length >= 60) return fail('60 actions maximum.');
  const l = [...list];
  l.splice(Number.isFinite(rank) ? rank : l.length, 0, { e: emoji, label });
  saveActions(l);
  $('#act-emoji').value = ''; $('#act-label').value = '';
  toast(`« ${label} » ajoutée en position ${l.findIndex((a) => a.label === label) + 1}`);
}

function openActions() {
  $('#act-error').hidden = true;
  $('#act-rank').value = '';
  renderActionsManager();
  $('#actions-dialog').showModal();
}

function deleteTask() {
  const t = S.editing;
  if (!t) return;
  $('#task-sheet').close();
  // Jamais d'effacement définitif : la tâche est seulement masquée (récupérable)
  track(updateDoc(doc(db, 'tasks', t.id), {
    deleted: true, deletedAt: Date.now(), updatedAt: serverTimestamp(), updatedBy: S.uid,
  }));
  toast('Tâche supprimée', {
    label: 'Annuler',
    run: () => track(updateDoc(doc(db, 'tasks', t.id), {
      deleted: false, deletedAt: deleteField(), updatedAt: serverTimestamp(), updatedBy: S.uid,
    })),
  });
}

// =====================================================================
//  Accueil : ma journée, récap de la semaine, rappels, notes partagées
// =====================================================================
const fLongDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const fShortDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric' });

function isMine(t) { return t.assignee === S.uid || t.assignee === 'both'; }

function celebrateIfAllDone(ds) {
  if (ds !== ymd(new Date())) return;
  const mine = (tasksByDay(ds, ds).get(ds) || []).filter(isMine);
  if (mine.length && mine.every((t) => isDone(t, ds))) toast('Tout est fait pour aujourd\'hui 🎉');
}

function card(title, side, ...body) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: title }), side || null),
    ...body);
}

function renderHome() {
  const now = new Date();
  const today = ymd(now);
  const me = S.members[S.uid];
  $('#period').textContent = me?.name ? `Bonjour ${me.name}` : 'Bonjour';
  $('#today-btn').hidden = true;

  // --- Ma journée ---
  const todayList = (tasksByDay(today, today).get(today) || []).filter(isMine);
  const doneToday = todayList.filter((t) => isDone(t, today)).length;
  const overdueFrom = ymd(addDays(now, -14));
  const yesterday = ymd(addDays(now, -1));
  const overdue = [];
  const past = tasksByDay(overdueFrom, yesterday);
  for (const [ds, list] of [...past.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const t of list) if (isMine(t) && !isDone(t, ds)) overdue.push([t, ds]);
  }
  const progress = todayList.length ? Math.round((doneToday / todayList.length) * 100) : 0;

  const myDay = card('Ma journée',
    todayList.length ? h('span', { class: 'card-count', text: `${doneToday} / ${todayList.length}` }) : null,
    todayList.length ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': progress, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Avancement du jour' },
      h('i', { vars: { '--p': `${progress}%`, '--c': colorOf(S.uid) } })) : null,
    todayList.length
      ? h('ul', { class: 'tasks' }, todayList.map((t) => taskRow(t, today, { side: t.assignee === 'both' ? 'Nous deux' : '' })))
      : h('p', { class: 'empty', text: 'Rien de prévu pour toi aujourd\'hui.' }),
    overdue.length ? h('h3', { class: 'sub', text: `En retard (${overdue.length})` }) : null,
    overdue.length ? h('ul', { class: 'tasks' }, overdue.map(([t, ds]) => taskRow(t, ds, { side: cap(fShortDay.format(parseYmd(ds))) }))) : null,
    h('button', { type: 'button', class: 'btn-ghost', onclick: () => openTask(null, today) }, '+ Ajouter une tâche'));

  // --- Récap de la semaine ---
  const wStart = mondayOf(now);
  const week = tasksByDay(ymd(wStart), ymd(addDays(wStart, 6)));
  const stats = new Map([...orderedUids(), 'both'].map((k) => [k, { total: 0, done: 0 }]));
  for (const [ds, list] of week) {
    for (const t of list) {
      const s = stats.get(t.assignee);
      if (!s) continue;
      s.total++; if (isDone(t, ds)) s.done++;
    }
  }
  const other = otherUid();
  const otherToday = other ? (tasksByDay(today, today).get(today) || []).filter((t) => t.assignee === other) : [];
  const recapRows = [...stats.entries()].filter(([k, s]) => k !== 'both' || s.total).map(([k, s]) => h('li', {},
    h('i', { class: k === 'both' ? 'both' : null, vars: whoVars(k) }),
    h('span', { class: 'r-name', text: k === S.uid ? `${nameOf(k)} (toi)` : whoLabel(k) }),
    h('span', { class: 'r-bar' }, h('b', { vars: { '--p': `${s.total ? Math.round((s.done / s.total) * 100) : 0}%`, ...whoVars(k) }, class: k === 'both' ? 'both' : null })),
    h('span', { class: 'r-count', text: `${s.done}/${s.total}` })));
  const recap = card('Cette semaine', null,
    h('ul', { class: 'recap' }, recapRows),
    other ? h('p', { class: 'small muted', text: otherToday.length
      ? `${nameOf(other)} a ${otherToday.length} tâche${otherToday.length > 1 ? 's' : ''} aujourd'hui (${otherToday.filter((t) => isDone(t, today)).length} faite${otherToday.filter((t) => isDone(t, today)).length > 1 ? 's' : ''}).`
      : `${nameOf(other)} n'a rien de prévu aujourd'hui.` }) : null);

  // --- Rappels ---
  const notes = [...S.notes.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const reminders = notes.filter((n) => n.kind === 'reminder').sort((a, b) => Number(a.done) - Number(b.done));
  const doneCount = reminders.filter((n) => n.done).length;
  const reminderCard = card('Rappels',
    doneCount ? h('button', { type: 'button', class: 'link-btn', onclick: clearDoneReminders, text: 'Effacer les faits' }) : null,
    reminders.length ? h('ul', { class: 'checklist' }, reminders.map((n) => h('li', { class: n.done ? 'is-done' : null },
      h('button', {
        type: 'button', class: 'check small', role: 'checkbox', 'aria-checked': String(!!n.done),
        'aria-label': `${n.text} : ${n.done ? 'fait' : 'à faire'}`, vars: { '--c': colorOf(n.createdBy) },
        onclick: () => updateNote(n, { done: !n.done }),
      }),
      h('button', { type: 'button', class: 'note-text', onclick: () => openNote(n), text: n.text })))) : h('p', { class: 'empty', text: 'Aucun rappel. Les choses à ne pas oublier, à cocher quand c\'est fait.' }),
    h('form', { class: 'quick-add', onsubmit: (e) => {
      e.preventDefault();
      const input = e.target.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      createNote('reminder', text);
      input.value = '';
    } },
    h('input', { type: 'text', maxlength: 200, placeholder: 'Ajouter un rappel…', 'aria-label': 'Nouveau rappel', enterkeyhint: 'done' }),
    h('button', { type: 'submit', class: 'icon-btn', 'aria-label': 'Ajouter le rappel' }, plusIcon())));

  // --- Notes partagées ---
  const shared = notes.filter((n) => n.kind === 'note').reverse();
  const notesCard = card('Notes partagées',
    h('button', { type: 'button', class: 'link-btn', onclick: () => openNote(null), text: '+ Note' }),
    shared.length ? h('div', { class: 'notes' }, shared.map((n) => h('button', { type: 'button', class: 'note', vars: { '--c': colorOf(n.createdBy) }, onclick: () => openNote(n) },
      h('span', { class: 'note-body', text: n.text }),
      h('span', { class: 'note-meta', text: `${nameOf(n.createdBy)} · ${fDayMonth.format(new Date(n.createdAt || Date.now()))}` }))))
      : h('p', { class: 'empty', text: 'Codes, idées, infos utiles… tout ce que vous voulez partager.' }));

  $('#home').replaceChildren(
    h('p', { class: 'home-date', text: cap(fLongDay.format(now)) }),
    myDay, recap, reminderCard, notesCard);
}

function plusIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '22'); svg.setAttribute('height', '22'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M12 5v14M5 12h14'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2.2'); p.setAttribute('stroke-linecap', 'round');
  svg.append(p);
  return svg;
}

// ---------- Notes et rappels ----------
function createNote(kind, text) {
  const ref = doc(collection(db, 'notes'));
  const data = {
    kind, text: text.slice(0, 2000), done: false, deleted: false,
    createdBy: S.uid, createdAt: Date.now(), updatedAt: serverTimestamp(), updatedBy: S.uid, v: DATA_VERSION,
  };
  S.notes.set(ref.id, { id: ref.id, ...data });
  renderHome();
  track(setDoc(ref, data));
}

function updateNote(n, changes) {
  Object.assign(n, changes);
  renderHome();
  track(updateDoc(doc(db, 'notes', n.id), { ...changes, updatedAt: serverTimestamp(), updatedBy: S.uid }));
}

function deleteNote(n) {
  // Jamais d'effacement définitif : la note est seulement masquée
  S.notes.delete(n.id);
  renderHome();
  track(updateDoc(doc(db, 'notes', n.id), { deleted: true, deletedAt: Date.now(), updatedAt: serverTimestamp(), updatedBy: S.uid }));
  toast(n.kind === 'note' ? 'Note supprimée' : 'Rappel supprimé', {
    label: 'Annuler',
    run: () => track(updateDoc(doc(db, 'notes', n.id), { deleted: false, deletedAt: deleteField(), updatedAt: serverTimestamp(), updatedBy: S.uid })),
  });
}

function clearDoneReminders() {
  const done = [...S.notes.values()].filter((n) => n.kind === 'reminder' && n.done);
  if (!done.length) return;
  const b = writeBatch(db);
  for (const n of done) {
    b.update(doc(db, 'notes', n.id), { deleted: true, deletedAt: Date.now(), updatedAt: serverTimestamp(), updatedBy: S.uid });
    S.notes.delete(n.id);
  }
  renderHome();
  track(b.commit());
  toast(`${done.length} rappel${done.length > 1 ? 's' : ''} effacé${done.length > 1 ? 's' : ''}`, {
    label: 'Annuler',
    run: () => {
      const u = writeBatch(db);
      for (const n of done) u.update(doc(db, 'notes', n.id), { deleted: false, deletedAt: deleteField(), updatedAt: serverTimestamp(), updatedBy: S.uid });
      track(u.commit());
    },
  });
}

function openNote(n) {
  S.editingNote = n;
  const kind = n ? n.kind : 'note';
  $('#note-title').textContent = n ? (kind === 'note' ? 'Note partagée' : 'Rappel') : 'Nouvelle note';
  $('#note-text').value = n ? n.text : '';
  $('#note-text').maxLength = kind === 'note' ? 2000 : 200;
  $('#note-delete').hidden = !n;
  $('#note-dialog').showModal();
  if (!n) setTimeout(() => $('#note-text').focus(), 60);
}

function saveNote(e) {
  e.preventDefault();
  const text = $('#note-text').value.trim();
  const n = S.editingNote;
  $('#note-dialog').close();
  if (!text) { if (n) deleteNote(n); return; }
  if (n) { if (text !== n.text) updateNote(n, { text }); }
  else createNote('note', text);
}

// =====================================================================
//  Sauvegardes
// =====================================================================

// Toutes les données (y compris les tâches supprimées) en JSON simple
async function collectData(fromServer) {
  const get = fromServer ? getDocsFromServer : getDocs;
  const [ts, ms, ns, cs] = await Promise.all([
    get(collection(db, 'tasks')), get(collection(db, 'members')),
    get(collection(db, 'notes')), get(collection(db, 'config')),
  ]);
  const tasks = {};
  ts.forEach((d) => { tasks[d.id] = plain(d.data()); });
  const notes = {};
  ns.forEach((d) => { notes[d.id] = plain(d.data()); });
  const members = {};
  ms.forEach((d) => { const m = d.data(); members[d.id] = { name: m.name, color: m.color }; });
  let actionsList = null;
  cs.forEach((d) => { if (d.id === 'actions' && Array.isArray(d.data().items)) actionsList = d.data().items; });
  return { app: 'maison', format: 2, dataVersion: DATA_VERSION, exportedAt: new Date().toISOString(), members, tasks, notes, actions: actionsList };
}

function backupDoc(data, kind) {
  const json = JSON.stringify(data);
  if (json.length > MAX_BACKUP_CHARS) throw new Error('backup-too-large');
  return { createdAt: serverTimestamp(), createdBy: S.uid, kind, count: Object.keys(data.tasks).length, json, v: 1 };
}

// Une copie automatique par jour, à la première ouverture de la journée
let backupRunning = false, backupDoneFor = null;
async function dailyBackup() {
  const today = ymd(new Date());
  if (backupRunning || backupDoneFor === today || !S.online) return;
  backupRunning = true;
  try {
    const ref = doc(db, 'backups', today);
    const existing = await getDocFromServer(ref);
    if (existing.exists()) {
      S.lastBackupAt = new Date(toMillis(existing.data().createdAt) || Date.now());
    } else {
      const data = await collectData(true);
      await setDoc(ref, backupDoc(data, 'auto'));
      S.lastBackupAt = new Date();
    }
    backupDoneFor = today;
    await cleanupOldBackups();
  } catch (e) {
    // Si l'autre téléphone a fait la copie au même moment, c'est normal d'être refusé ici
    if (e?.code !== 'permission-denied') console.warn('Copie du jour non faite', e);
    else backupDoneFor = today;
  } finally {
    backupRunning = false;
  }
}

async function cleanupOldBackups() {
  const limitDate = Timestamp.fromMillis(Date.now() - (BACKUP_KEEP_DAYS + 1) * 86400000);
  const old = await getDocsFromServer(query(collection(db, 'backups'), where('createdAt', '<', limitDate)));
  if (old.empty) return;
  const b = writeBatch(db);
  old.forEach((d) => b.delete(d.ref));
  await b.commit();
}

// --- Télécharger une copie sur l'appareil ---
async function exportFile() {
  let data;
  try { data = await collectData(S.online); } catch { data = await collectData(false); }
  const name = `maison-sauvegarde-${ymd(new Date())}.json`;
  const file = new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (mobile && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      rememberExport();
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  rememberExport();
}
function rememberExport() {
  try { localStorage.setItem('lastExport', String(Date.now())); } catch { /* rien */ }
  renderBackupInfo();
  toast('Copie téléchargée ✓');
}

// --- Réimporter un fichier ---
async function importFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Ce fichier n\'est pas une sauvegarde valide.'); return; }
  if (!data || data.app !== 'maison' || typeof data.tasks !== 'object') { toast('Ce fichier n\'est pas une sauvegarde de Maison.'); return; }
  const when = data.exportedAt ? fFull.format(new Date(data.exportedAt)) : 'date inconnue';
  await restoreFrom(data, `Fichier du ${when}`);
}

// --- Restaurer (copie en ligne ou fichier) ---
function cleanTask(t, validUids) {
  if (!t || typeof t.title !== 'string' || !t.title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) return null;
  const assignee = t.assignee === 'both' || validUids.includes(t.assignee) ? t.assignee : 'both';
  const completions = {};
  if (t.completions && typeof t.completions === 'object') {
    for (const [d, c] of Object.entries(t.completions)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && c && typeof c === 'object') {
        completions[d] = { by: validUids.includes(c.by) ? c.by : S.uid, at: typeof c.at === 'number' ? c.at : Date.now() };
      }
    }
  }
  const out = {
    title: t.title.trim().slice(0, 120), date: t.date, assignee, completions,
    repeat: t.repeat && typeof t.repeat === 'object' ? t.repeat : null,
    deleted: !!t.deleted,
    createdBy: validUids.includes(t.createdBy) ? t.createdBy : S.uid,
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
    v: DATA_VERSION,
  };
  if (typeof t.comment === 'string' && t.comment.trim()) out.comment = t.comment.trim().slice(0, 500);
  if (out.deleted) out.deletedAt = typeof t.deletedAt === 'number' ? t.deletedAt : Date.now();
  return out;
}

function cleanNote(n, validUids) {
  if (!n || (n.kind !== 'note' && n.kind !== 'reminder') || typeof n.text !== 'string' || !n.text.trim()) return null;
  const out = {
    kind: n.kind, text: n.text.trim().slice(0, 2000), done: !!n.done, deleted: !!n.deleted,
    createdBy: validUids.includes(n.createdBy) ? n.createdBy : S.uid,
    createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
    v: DATA_VERSION,
  };
  if (out.deleted) out.deletedAt = typeof n.deletedAt === 'number' ? n.deletedAt : Date.now();
  return out;
}

function cleanActions(list) {
  if (!Array.isArray(list)) return null;
  const out = list.filter((a) => a && typeof a.e === 'string' && ONE_EMOJI_RE.test(a.e) && typeof a.label === 'string' && a.label.trim())
    .slice(0, 60).map((a) => ({ e: a.e, label: a.label.trim().slice(0, 30) }));
  return out.length ? out : null;
}

async function restoreFrom(data, label) {
  if (!S.online) { toast('Connecte-toi à internet pour restaurer.'); return; }
  const entries = Object.entries(data.tasks || {});
  const visible = entries.filter(([, t]) => !t?.deleted).length;
  const ok = await confirmDialog(
    'Restaurer cette copie ?',
    `${label} · ${visible} tâche${visible > 1 ? 's' : ''}.\n\nLes tâches${data.notes ? ', notes et rappels' : ''} actuels seront remplacés par ceux de la copie. Juste avant, une copie de l'état actuel est faite : tu pourras revenir en arrière.`,
    'Restaurer',
  );
  if (!ok) return;

  toast('Restauration en cours…');
  try {
    // 1. Filet de sécurité : copie de l'état actuel
    const current = await collectData(true);
    const now = new Date();
    await setDoc(doc(db, 'backups', `${ymd(now)}_avant-restauration_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`),
      backupDoc(current, 'avant-restauration'));

    // 2. Écriture des tâches de la copie ; les autres sont masquées, jamais effacées
    const validUids = Object.keys(S.members);
    const ops = [];
    const keep = new Set();
    for (const [id, t] of entries) {
      const clean = cleanTask(t, validUids);
      if (!clean || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
      keep.add(id);
      ops.push((b) => b.set(doc(db, 'tasks', id), { ...clean, updatedAt: serverTimestamp(), updatedBy: S.uid }));
    }
    for (const [id, t] of Object.entries(current.tasks)) {
      if (!keep.has(id) && !t.deleted) {
        ops.push((b) => b.update(doc(db, 'tasks', id), { deleted: true, deletedAt: Date.now(), updatedAt: serverTimestamp(), updatedBy: S.uid }));
      }
    }
    // Notes et rappels (les anciennes copies n'en ont pas : on ne touche alors à rien)
    if (data.notes && typeof data.notes === 'object') {
      const keepNotes = new Set();
      for (const [id, n] of Object.entries(data.notes)) {
        const clean = cleanNote(n, validUids);
        if (!clean || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
        keepNotes.add(id);
        ops.push((b) => b.set(doc(db, 'notes', id), { ...clean, updatedAt: serverTimestamp(), updatedBy: S.uid }));
      }
      for (const [id, n] of Object.entries(current.notes || {})) {
        if (!keepNotes.has(id) && !n.deleted) {
          ops.push((b) => b.update(doc(db, 'notes', id), { deleted: true, deletedAt: Date.now(), updatedAt: serverTimestamp(), updatedBy: S.uid }));
        }
      }
    }
    // Liste des actions
    const acts = cleanActions(data.actions);
    if (acts) ops.push((b) => b.set(doc(db, 'config', 'actions'), { items: acts, updatedAt: serverTimestamp(), updatedBy: S.uid }));
    for (let i = 0; i < ops.length; i += 400) {
      const b = writeBatch(db);
      ops.slice(i, i + 400).forEach((f) => f(b));
      await b.commit();
    }
    S.lastSaved = new Date();
    $('#menu-sheet').close();
    toast('Copie restaurée ✓');
  } catch (e) {
    console.error(e);
    toast('La restauration n\'a pas pu aller au bout. L\'état d\'avant est gardé dans les copies en ligne.');
  }
}

// --- Liste des copies en ligne ---
const KIND_LABEL = { auto: 'Copie du jour', 'avant-restauration': 'Avant une restauration' };
async function renderBackupList() {
  const ul = $('#backup-list');
  if (!S.online) { ul.replaceChildren(h('li', { class: 'muted' }, 'Disponible avec une connexion internet.')); return; }
  ul.replaceChildren(h('li', { class: 'muted' }, 'Chargement…'));
  try {
    const snap = await getDocsFromServer(query(collection(db, 'backups'), orderBy('createdAt', 'desc'), limit(45)));
    if (snap.empty) { ul.replaceChildren(h('li', { class: 'muted' }, 'Aucune copie pour l\'instant. La première se fait automatiquement aujourd\'hui.')); return; }
    ul.replaceChildren(...snap.docs.map((d) => {
      const b = d.data();
      const at = new Date(toMillis(b.createdAt) || 0);
      return h('li', {},
        h('div', { class: 'b-main' },
          h('div', { text: `${cap(fFull.format(at))} · ${fTime.format(at)}` }),
          h('div', { class: 'b-sub', text: `${KIND_LABEL[b.kind] || 'Copie'} · ${b.count ?? '?'} tâche${b.count > 1 ? 's' : ''} · par ${nameOf(b.createdBy)}` })),
        h('button', {
          type: 'button', text: 'Restaurer',
          onclick: () => {
            let data;
            try { data = JSON.parse(b.json); } catch { toast('Cette copie est illisible.'); return; }
            restoreFrom(data, `Copie du ${fFull.format(at)} à ${fTime.format(at)}`);
          },
        }));
    }));
  } catch (e) {
    console.error(e);
    ul.replaceChildren(h('li', { class: 'muted' }, 'Impossible de charger les copies pour le moment.'));
  }
}

function renderBackupInfo() {
  let last = null;
  try { last = Number(localStorage.getItem('lastExport')) || null; } catch { /* rien */ }
  const parts = [];
  parts.push(S.lastBackupAt ? `Copie en ligne du jour : faite ✓` : 'Copie en ligne du jour : en attente de connexion.');
  parts.push(last ? `Dernier fichier téléchargé sur cet appareil : ${fFull.format(new Date(last))}.` : 'Aucun fichier téléchargé sur cet appareil pour l\'instant.');
  $('#backup-info').textContent = parts.join(' ');
}

// =====================================================================
//  Réglages
// =====================================================================
// Thème : interrupteur « Comme le téléphone » + deux icônes soleil / lune
function renderThemeSeg() {
  const auto = $('#theme-auto');
  if (!auto) return;
  const pref = themePref();
  auto.checked = pref === 'auto';
  const current = isDark() ? 'dark' : 'light';
  $('#theme-manual').classList.toggle('is-auto', pref === 'auto');
  document.querySelectorAll('[data-theme-choice]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.themeChoice === current));
  });
}

// ---------- Changer le mot de passe ----------
function openPassword() {
  $('#password-form').reset();
  $('#pw-error').hidden = true;
  $('#password-dialog').showModal();
  setTimeout(() => $('#pw-current').focus(), 60);
}

async function changePassword(e) {
  e.preventDefault();
  const err = $('#pw-error');
  const cur = $('#pw-current').value;
  const next = $('#pw-new').value;
  const conf = $('#pw-confirm').value;
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  err.hidden = true;
  if (!cur) return fail('Écris ton mot de passe actuel.');
  if (next.length < 12) return fail('Le nouveau mot de passe doit faire au moins 12 caractères.');
  if (next !== conf) return fail('Les deux nouveaux mots de passe ne sont pas identiques.');
  if (next === cur) return fail('Le nouveau mot de passe doit être différent de l\'actuel.');
  if (!S.online) return fail('Il faut une connexion internet.');
  const btn = $('#pw-submit');
  btn.disabled = true;
  try {
    const user = auth.currentUser;
    // Par sécurité, Firebase redemande le mot de passe actuel avant tout changement
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, cur));
    await updatePassword(user, next);
    $('#password-dialog').close();
    toast('Mot de passe changé ✓');
  } catch (x) {
    switch (x?.code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password': fail('Mot de passe actuel incorrect.'); break;
      case 'auth/weak-password':
      case 'auth/password-does-not-meet-requirements': fail('Ce mot de passe est trop simple. Choisis-en un plus long.'); break;
      case 'auth/too-many-requests': fail('Trop d\'essais. Réessaie dans quelques minutes.'); break;
      case 'auth/network-request-failed': fail('Pas de connexion internet.'); break;
      default: fail('Le changement n\'a pas pu se faire. Réessaie.');
    }
  } finally { btn.disabled = false; }
}

function openMenu() {
  const me = S.members[S.uid] || {};
  $('#menu-name').value = me.name || '';
  renderProfileColors('#menu-colors', me.color);
  renderThemeSeg();
  renderBackupInfo();
  $('#version-info').textContent = `Version ${APP_VERSION}`;
  $('#menu-sheet').showModal();
  renderBackupList();
}

// =====================================================================
//  Branchement des boutons
// =====================================================================
function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
}

function authMessage(e) {
  switch (e?.code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-email':
    case 'auth/user-not-found':
    case 'auth/wrong-password': return 'E-mail ou mot de passe incorrect.';
    case 'auth/too-many-requests': return 'Trop d\'essais. Réessaie dans quelques minutes.';
    case 'auth/network-request-failed': return 'Pas de connexion internet.';
    case 'auth/user-disabled': return 'Ce compte est désactivé.';
    default: return 'Connexion impossible. Réessaie.';
  }
}

function bindUi() {
  // Connexion
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    const btn = $('#login-submit');
    err.hidden = true; btn.disabled = true;
    try {
      await signInWithEmailAndPassword(auth, $('#login-email').value.trim(), $('#login-password').value);
    } catch (x) {
      err.textContent = authMessage(x); err.hidden = false;
    } finally { btn.disabled = false; }
  });
  $('#forgot-btn').addEventListener('click', async () => {
    const email = $('#login-email').value.trim();
    const err = $('#login-error');
    if (!email) { err.textContent = 'Écris d\'abord ton e-mail ci-dessus.'; err.hidden = false; return; }
    try { await sendPasswordResetEmail(auth, email); } catch { /* on ne dit pas si le compte existe */ }
    err.hidden = true;
    toast('Si ce compte existe, un e-mail de réinitialisation vient d\'être envoyé.');
  });
  $('#denied-logout').addEventListener('click', () => signOut(auth));

  // Profil (premier lancement)
  $('#profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#profile-name').value.trim();
    const color = $('#profile-colors').dataset.value;
    if (!name) { $('#profile-error').textContent = 'Écris ton prénom.'; $('#profile-error').hidden = false; return; }
    saveProfile(name, color);
    enterMain();
  });

  // Navigation semaine
  $('#prev-btn').addEventListener('click', () => goStep(-1));
  $('#next-btn').addEventListener('click', () => goStep(1));
  $('#today-btn').addEventListener('click', goToday);
  $('#view-home').addEventListener('click', () => setView('home'));
  $('#view-week').addEventListener('click', () => setView('week'));
  $('#view-month').addEventListener('click', () => setView('month'));
  // Balayage gauche/droite pour changer de semaine ou de mois
  for (const zone of [$('#week'), $('#month')]) {
    let sx = null, sy = null;
    zone.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    zone.addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      sx = null;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) goStep(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  $('#theme-auto').addEventListener('change', (e) => applyTheme(e.target.checked ? 'auto' : (isDark() ? 'dark' : 'light')));
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.themeChoice)));
  $('#password-btn').addEventListener('click', openPassword);
  $('#actions-btn').addEventListener('click', openActions);
  $('#actions-close').addEventListener('click', () => $('#actions-dialog').close());
  $('#actions-form').addEventListener('submit', addAction);
  $('#actions-reset').addEventListener('click', async () => {
    const ok = await confirmDialog('Revenir à la liste de départ ?', 'Les actions ajoutées seront retirées de la liste. Les tâches déjà créées ne changent pas.', 'Revenir');
    if (ok) { const before = actions(); saveActions(DEFAULT_ACTIONS.map((a) => ({ ...a }))); toast('Liste de départ remise', { label: 'Annuler', run: () => saveActions(before) }); }
  });
  $('#note-form').addEventListener('submit', saveNote);
  $('#note-cancel').addEventListener('click', () => $('#note-dialog').close());
  $('#note-delete').addEventListener('click', () => { $('#note-dialog').close(); if (S.editingNote) deleteNote(S.editingNote); });
  $('#password-form').addEventListener('submit', changePassword);
  $('#pw-cancel').addEventListener('click', () => $('#password-dialog').close());
  $('#menu-btn').addEventListener('click', openMenu);
  $('#fab').addEventListener('click', () => {
    const today = new Date();
    if (S.view === 'month') { openTask(null, S.selDay); return; }
    const inWeek = ymd(mondayOf(today)) === ymd(S.weekStart);
    openTask(null, inWeek ? ymd(today) : ymd(S.weekStart));
  });
  $('#status').addEventListener('click', statusDetails);

  // Fiche tâche
  $('#task-form').addEventListener('submit', saveTask);
  $('#task-title').addEventListener('input', (e) => {
    if (S.emojiManual) return;
    const guess = suggestEmoji(e.target.value);
    if (guess !== S.pickedEmoji) { S.pickedEmoji = guess; renderEmojiPicker(); }
  });
  $('#task-cancel').addEventListener('click', () => $('#task-sheet').close());
  $('#task-delete').addEventListener('click', deleteTask);

  // Réglages
  $('#menu-close').addEventListener('click', () => $('#menu-sheet').close());
  $('#menu-name').addEventListener('change', (e) => { if (e.target.value.trim()) saveProfile(e.target.value, null); });
  $('#export-btn').addEventListener('click', () => exportFile().catch((e) => { console.error(e); toast('Le téléchargement a échoué.'); }));
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) importFile(f);
  });
  $('#logout-btn').addEventListener('click', async () => {
    const pending = S.writing > 0 || S.snapPending;
    const ok = await confirmDialog('Se déconnecter ?',
      pending ? 'Attention : des modifications n\'ont pas encore été envoyées. Reconnecte-toi à internet avant de te déconnecter.' : 'Tu devras retaper ton e-mail et ton mot de passe.',
      'Se déconnecter', true);
    if (ok) { $('#menu-sheet').close(); signOut(auth); }
  });

  [$('#task-sheet'), $('#menu-sheet'), $('#actions-dialog')].forEach(closeOnBackdrop);

  // Au retour sur l'app (le lendemain par exemple) : on revient à aujourd'hui et on refait la copie du jour si besoin
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt > 30 * 60000 && !$('#screen-main').hidden) {
      // Retour après une pause : on revient à l'accueil du jour
      S.view = 'home'; goToday();
      return void (S.synced && dailyBackup());
    }
    if (!$('#screen-main').hidden) { renderView(); if (S.synced) dailyBackup(); }
  });
}

start();
