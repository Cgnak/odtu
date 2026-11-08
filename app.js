/* ODTÜ — personal student app.
   Home (Bugün) is a glance screen: what to do, where the next class is, what changed.
   The other tabs hold the detail: week agenda + semester calendar, course pages, inbox, campus.
   Data: data.enc.json = AES-256-GCM encrypted pano.json (key from a passphrase via PBKDF2-SHA256),
   key kept in IndexedDB as a non-extractable CryptoKey. On localhost a plain pano.json is used.
   ?an=2026-11-10T13:55 (localhost only) pretends "now" is that moment. */
'use strict';

// ---------------------------------------------------------------- constants
const COURSES = {
  'MATH 119': { short: 'Calculus', hue: 350 },
  'STAT 101': { short: 'İstatistik', hue: 210 },
  'STAT 112': { short: 'Veri görselleştirme', hue: 160 },
  'CEIT 101': { short: 'Programlama', hue: 265 },
  'ENG 101': { short: 'Akademik İngilizce', hue: 32 },
};
const ORDER = Object.keys(COURSES);
const TABS = ['bugun', 'takvim', 'dersler', 'gelen', 'kampus'];
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');
let D = null;          // pano.json
let TODOS = [];        // derived to-do rows
const ui = { feedCourse: '', q: '', agenda: 'hafta', onlyExams: false, kampus: 'yemek', gun: null };

// ---------------------------------------------------------------- tiny DOM helpers
function h(sel, attrs, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k instanceof Node ? k : document.createTextNode(String(k)))));
const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = d; return s; };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const DONE = new Set(store.get('odtu-done', []));
const SEEN = new Set(store.get('odtu-seen', []));

// ---------------------------------------------------------------- time + wording
const pretend = LOCAL ? new URLSearchParams(location.search).get('an') : null;
const now = () => (pretend ? new Date(pretend) : new Date());
const today = () => { const d = now(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (s) => new Date(s + 'T00:00');
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysTo = (s) => Math.round((day(s) - today()) / 864e5);
const wd = (d) => (d.getDay() + 6) % 7 + 1;
const mins = (hhmm) => { const [a, b] = hhmm.split(':').map(Number); return a * 60 + b; };
const nowMin = () => { const d = now(); return d.getHours() * 60 + d.getMinutes(); };
const fmt = (d, o) => d.toLocaleDateString('tr-TR', o);
const lower = (s) => (s || '').toLocaleLowerCase('tr-TR');
const cap = (s) => (s ? s[0].toLocaleUpperCase('tr-TR') + s.slice(1) : s);
const hasTime = (t) => t && t !== '00:00';
const when = (s) => { const n = daysTo(s); return n === 0 ? 'bugün' : n === 1 ? 'yarın' : n === -1 ? 'dün' : n > 1 && n < 7 ? fmt(day(s), { weekday: 'long' }) : fmt(day(s), { day: 'numeric', month: 'long' }); };
const left = (s) => { const n = daysTo(s); return n === 0 ? 'bugün' : n === 1 ? 'yarın' : n > 1 ? `${n} gün kaldı` : `${-n} gün önce`; };
const inMin = (m) => (m < 60 ? `${m} dk` : `${Math.floor(m / 60)} sa${m % 60 ? ' ' + (m % 60) + ' dk' : ''}`);
const cname = (c) => (COURSES[c] || {}).short || (c === 'Genel' ? 'ODTÜ' : c);
const color = (c) => `hsl(${(COURSES[c] || { hue: 220 }).hue} 70% 50%)`;
const dot = (c) => h('i.cdot', { style: { background: color(c) } });
const courseTag = (c) => h('span.cname', dot(c), cname(c));
const slug = (c) => c.replace(' ', '-');
const unslug = (s) => (s || '').replace('-', ' ');
const msgId = (r) => `${r.at}|${r.course}|${r.title}`.slice(0, 120);
const kindLabel = (c) => ({ Recitation: 'Recitation', Lab: 'Lab', Teori: 'Teori' }[c.kind] || 'Ders');

/** what the student has to do, in plain Turkish */
function action(r) {
  const t = r.title.replace(/^Pratix( quiz)?: /, '').replace(/^Peercept( akran değerlendirmesi)?: /, '');
  const note = r.note || '';
  if (r.kind === 'sınav') return { verb: 'Sınav', what: t.replace(/\s*\(.*\)$/, ''), note: note || (t.match(/\((.*)\)$/) || [])[1] || '', urgent: true };
  if (r.kind === 'quiz') return /^quiz/i.test(t) ? { verb: t, what: '', note, urgent: true } : { verb: 'Quiz', what: t, note, urgent: true };
  if (r.kind === 'sunum') return { verb: 'Sözlü değerlendirme', what: t, note, urgent: true };
  if (r.kind === 'bilgi') return { verb: 'Hatırlatma', what: t, note, info: true };
  if (/^Pratix: /.test(r.title)) return { verb: 'Pratix’te tamamla', what: t, note };
  if (/^Pratix quiz/.test(r.title)) return { verb: 'Pratix quiz’ini çöz', what: t, note };
  if (/akran/.test(r.title)) return { verb: 'Akran değerlendirmesi yap', what: t, note };
  if (r.kind === 'form') return { verb: 'Formu doldur', what: t.replace(/ \(kapanış\)$/, ''), note };
  return { verb: 'Teslim et', what: t, note };
}

// ---------------------------------------------------------------- data views
function classesOn(date) {
  const d = iso(date);
  return (D.schedule || []).filter((c) => c.weekday === wd(date)).sort((a, b) => a.start.localeCompare(b.start)).map((c) => {
    const ch = (D.changes || []).find((x) => x.date === d && x.course === c.course && (!x.time || x.time === c.start));
    return ch ? { ...c, change: ch } : c;
  });
}
const attends = (c) => !c.change || c.change.kind !== 'iptal';
function nextClass() {
  const t = today(), m = nowMin();
  const todays = classesOn(t).filter(attends);
  const cur = todays.find((c) => mins(c.start) <= m && m < mins(c.end));
  if (cur) return { c: cur, state: 'now', date: t, mins: mins(cur.end) - m };
  const nxt = todays.find((c) => mins(c.start) > m);
  if (nxt) return { c: nxt, state: 'today', date: t, mins: mins(nxt.start) - m };
  for (let i = 1; i <= 7; i++) { const d = addDays(t, i); const l = classesOn(d).filter(attends); if (l.length) return { c: l[0], state: 'later', date: d, mins: null }; }
  return null;
}
const recentFeed = (hours) => (D.feed || []).filter((r) => (r.course !== 'Genel' || r.important) && (now() - new Date(r.at)) / 36e5 <= hours);
const unseenCount = () => recentFeed(72).filter((r) => !SEEN.has(msgId(r))).length;
const meals = (d) => (D.menu || []).filter((m) => m.date === d && m.meal !== 'Kahvaltı');
const photo = (dish) => (D.food_photos || {})[dish] || '';

// ring: GTFS departures per stop (METU App open data)
const TR_STOP = [['Dogu', 'Doğu'], ['Bati', 'Batı'], ['Muh.', 'Müh.'], ['Egitim', 'Eğitim'], ['Gida', 'Gıda'], ['Insaat', 'İnşaat'], ['Is Bankasi', 'İş Bankası'],
  ['Kutuphane', 'Kütüphane'], ['Mimarlik', 'Mimarlık'], ['Rektorluk', 'Rektörlük'], ['Kapisi', 'Kapısı'], ['Havacilik', 'Havacılık'], ['Endustri', 'Endüstri'],
  ['Odtukent', 'ODTÜKENT'], ['ODTU', 'ODTÜ'], ['Ziraat Bankasi', 'Ziraat Bankası'], ['IIBF', 'İİBF'], ['Makina', 'Makina'], ['Jeoloji', 'Jeoloji']];
const trStop = (s) => TR_STOP.reduce((a, [x, y]) => a.replace(x, y), s);
const myStop = () => store.get('odtu-stop', 'Dogu Yurtlar');
function departures(stop, limit = 8, horizon = 24 * 60) {
  const R = D.ring || {}; const s = (R.stops || {})[stop]; if (!s) return [];
  const svc = wd(today()) >= 6 ? 'weekend' : 'weekdays';
  const m = nowMin();
  return (s[svc] || []).map(([t, r]) => ({ t, r, in: mins(t) - m })).filter((x) => x.in >= 0 && x.in <= horizon).slice(0, limit)
    .map((x) => ({ ...x, route: (R.routes || {})[x.r] || { name: x.r, color: '#888' } }));
}
const ringStale = () => (D.ring || {}).valid_until && (D.ring.valid_until < iso(today()));

// ---------------------------------------------------------------- crypto + loading
const IDB = {
  open: () => new Promise((res, rej) => { const r = indexedDB.open('odtu-app', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
  async get(k) { try { const db = await IDB.open(); return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch { return undefined; } },
  async set(k, v) { try { const db = await IDB.open(); await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); } catch {} },
  async del(k) { try { const db = await IDB.open(); await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = res; }); } catch {} },
};
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(salt), iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function decrypt(enc, key) {
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.ct))));
}
const fetchJSON = async (u) => { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(r.status); return r.json(); };

async function load() {
  if (LOCAL) { try { D = await fetchJSON('pano.json'); return start(); } catch { /* try encrypted */ } }
  let enc;
  try { enc = await fetchJSON('data.enc.json'); } catch { return fatal('Veri alınamadı. İnternet bağlantını kontrol et.'); }
  const saved = await IDB.get('key');
  if (saved && saved.salt === enc.salt && saved.iter === enc.iter) {
    try { D = await decrypt(enc, saved.key); return start(); } catch { await IDB.del('key'); }
  }
  lockScreen(enc);
}
function lockScreen(enc) {
  tabbar.hidden = true;
  const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Parola', 'aria-label': 'Parola', required: true });
  const err = h('p.err', { role: 'alert' });
  const btn = h('button.btn', { type: 'submit' }, 'Aç');
  put(app, h('div.lock', h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; btn.textContent = 'Açılıyor…'; err.textContent = '';
      try { const key = await deriveKey(input.value, enc.salt, enc.iter); D = await decrypt(enc, key); await IDB.set('key', { key, salt: enc.salt, iter: enc.iter }); start(); }
      catch { err.textContent = 'Parola yanlış.'; btn.disabled = false; btn.textContent = 'Aç'; input.select(); }
    },
  }, h('h1', 'ODTÜ'), h('p.muted', 'Verilerin şifreli. Bu cihazda parolanı bir kez gir, sonra hatırlanır.'), input, btn, err)));
  input.focus();
}
function fatal(text) { put(app, h('div.lock', h('div', h('h1', 'ODTÜ'), h('p.muted', text), h('button.btn', { onclick: () => location.reload() }, 'Tekrar dene')))); }

function start() {
  TODOS = (D.deadlines || []).filter((r) => !r.past && ['sınav', 'quiz', 'ödev', 'form', 'sunum', 'bilgi'].includes(r.kind) && daysTo(r.date) >= 0 && daysTo(r.date) <= 28)
    .map((r) => ({ ...r, ...action(r) }));
  tabbar.hidden = false;
  window.addEventListener('hashchange', route);
  route();
  setInterval(() => { if (!document.hidden && (location.hash || '#bugun') === '#bugun') route(); }, 60000);
}

// ---------------------------------------------------------------- router
function route() {
  const [name, a1, a2] = (location.hash.slice(1) || 'bugun').split('/');
  const tab = name === 'ders' ? 'dersler' : TABS.includes(name) ? name : 'bugun';
  if (name === 'kampus' && ['yemek', 'ring'].includes(a1)) ui.kampus = a1;
  tabbar.querySelectorAll('a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    a.querySelector('.dot')?.remove();
    if (a.dataset.tab === 'gelen' && unseenCount()) a.append(h('i.dot', { 'aria-label': 'yeni' }));
  });
  const view = { bugun: Home, takvim: Agenda, dersler: Courses, ders: () => Course(unslug(a1), a2 || 'ozet'), gelen: Inbox, kampus: Campus, ayarlar: Settings }[name] || Home;
  const keep = name === app.dataset.last ? window.scrollY : 0;
  put(app, h('div.view', view()));
  window.scrollTo(0, keep);
  app.dataset.last = name;
}

// ---------------------------------------------------------------- shared pieces
const header = (eyebrow, title, extra) => h('div.headrow', h('div', eyebrow ? h('div.eyebrow', eyebrow) : null, h('h1.title', title)), extra || null);
const sec = (text, link) => h('h2.sec', h('span', text), link ? h('a', { href: link[1] }, link[0]) : null);
const kindTag = (k) => h('span.tag.' + k, { sınav: 'Sınav', quiz: 'Quiz', sunum: 'Sözlü', ödev: 'Teslim', form: 'Form', bilgi: 'Bilgi', tatil: 'Tatil', akademik: 'Akademik', iptal: 'İptal', değişiklik: 'Değişiklik' }[k] || k);

function taskItem(t, rerender) {
  return h('li.task' + (DONE.has(t.id) ? '.done' : '') + (t.info ? '.info' : ''),
    h('button.check', { 'aria-label': DONE.has(t.id) ? 'Yapılmadı olarak işaretle' : 'Yapıldı olarak işaretle', 'aria-pressed': String(DONE.has(t.id)),
      onclick: () => { DONE.has(t.id) ? DONE.delete(t.id) : DONE.add(t.id); store.set('odtu-done', [...DONE]); rerender(); } }),
    h('div',
      h('div', h('span.verb' + (t.urgent ? '.urgent' : ''), t.verb), t.what ? [' · ', h('span.what', t.what)] : null),
      h('div.meta', courseTag(t.course),
        h('span.due' + (daysTo(t.date) <= 2 && !t.info ? '.soon' : ''), `${cap(when(t.date))}${hasTime(t.time) ? ' ' + t.time : ''}${daysTo(t.date) > 1 ? ' · ' + left(t.date) : ''}`)),
      t.note ? h('span.note', t.note) : null));
}

function messageItem(r) {
  const id = msgId(r);
  const fresh = !SEEN.has(id) && (now() - new Date(r.at)) / 36e5 <= 72;
  return h('li', h('details.msg', {
    ontoggle: (e) => { if (e.target.open && !SEEN.has(id)) { SEEN.add(id); store.set('odtu-seen', [...SEEN].slice(-800)); e.target.querySelector('.new')?.remove(); } },
  },
  h('summary', h('span.t', r.title, fresh ? h('span.new', 'Yeni') : null),
    h('span.m', courseTag(r.course), h('span', fmt(new Date(r.at), { day: 'numeric', month: 'short' }) + ' ' + new Date(r.at).toTimeString().slice(0, 5)), h('span', r.kind === 'Duyuru' ? 'ODTÜClass duyurusu' : r.kind === 'Mail' ? 'Mail' : r.kind), r.from && r.from !== r.kind ? h('span', r.from) : null),
    /^https?:/.test(r.source || '') ? h('a.small', { href: r.source, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, 'Kaynağı aç ↗') : null),
  h('p', r.text || '')));
}

// ---------------------------------------------------------------- Bugün (glance)
function Home() {
  const open = TODOS.filter((t) => !DONE.has(t.id));
  const week = open.filter((t) => daysTo(t.date) <= 7 && !t.info);
  const n = nextClass();
  const changes = (D.changes || []).filter((x) => daysTo(x.date) >= 0 && daysTo(x.date) <= 2);
  const groups = [['Bugün ve yarın', (t) => daysTo(t.date) <= 1], ['Bu hafta', (t) => daysTo(t.date) >= 2 && daysTo(t.date) <= 7], ['Sonra', (t) => daysTo(t.date) > 7 && daysTo(t.date) <= 14]];
  const news = recentFeed(48);
  const lunch = meals(iso(today())).find((m) => m.meal === 'Öğle Yemeği');
  const gear = h('a.iconbtn', { href: '#ayarlar', 'aria-label': 'Ayarlar' }, svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'));

  return [
    header(cap(fmt(today(), { weekday: 'long', day: 'numeric', month: 'long' })),
      week.length ? ['Bu hafta ', h('em', `${week.length} işin`), ' var.'] : 'Bu hafta yapman gereken bir şey yok.', gear),
    changes.map((x) => h('div.banner.bad', h('b', x.kind === 'iptal' ? 'İptal: ' : 'Değişiklik: '), `${cname(x.course)} · ${when(x.date)}${x.time ? ' ' + x.time : ''} — ${x.title}${x.note ? ' (' + x.note + ')' : ''}`)),
    n ? h('a.card.next', { href: '#takvim' }, dot(n.c.course),
      h('div', h('b', n.state === 'now' ? 'Şu an: ' : 'Sıradaki ders: ', cname(n.c.course), n.c.kind !== 'Ders' ? ' ' + lower(kindLabel(n.c)) : ''),
        h('div.sub', `${n.state === 'later' ? cap(fmt(n.date, { weekday: 'long' })) + ' ' : ''}${n.c.start}–${n.c.end} · ${n.c.room}`)),
      n.mins != null ? h('span.live', n.state === 'now' ? `${inMin(n.mins)} kaldı` : `${inMin(n.mins)} sonra`) : null) : null,
    (() => {
      const d = departures(myStop(), 1, 90)[0];
      return d ? h('a.ringline', { href: '#kampus/ring' }, h('i.cdot', { style: { background: d.route.color } }),
        `${trStop(myStop())} durağından sıradaki ring: `, h('b', `${d.t} ${d.route.name}`), ` · ${d.in === 0 ? 'şimdi' : inMin(d.in) + ' sonra'}`) : null;
    })(),
    groups.map(([title, f]) => {
      const list = TODOS.filter(f);
      return list.length ? [sec(title), h('ul.list', list.map((t) => taskItem(t, route)))] : null;
    }),
    !TODOS.some((t) => daysTo(t.date) <= 14) ? h('div.card.pad.muted', '14 gün içinde kayıtlı bir iş yok.') : null,
    sec('Yeni gelenler', ['Tümü', '#gelen']),
    news.length ? h('ul.list', news.slice(0, 4).map(messageItem)) : h('div.card.pad.muted', 'Son 2 günde ders duyurusu ya da maili yok.'),
    sec('Öğle yemeği', ['Hafta', '#kampus']),
    lunch ? (() => {
      const main = lunch.dishes.split(', ').find((x, i) => i > 0 && photo(x)) || lunch.dishes.split(', ').find(photo);
      return h('a.card.lunch', { href: '#kampus' }, main ? h('img', { src: photo(main), alt: cap(lower(main)), loading: 'lazy' }) : null,
        h('div', cap(lower(lunch.dishes)), lunch.veg ? h('div.veg', 'Vejetaryen: ' + lower(lunch.veg)) : null));
    })() : h('div.card.pad.muted', 'Bugün için menü yok.'),
  ];
}

// ---------------------------------------------------------------- Takvim (detail)
function Agenda() {
  const seg = h('div.seg', [['hafta', '2 hafta'], ['donem', 'Dönem takvimi']].map(([k, l]) =>
    h('button', { type: 'button', 'aria-pressed': String(ui.agenda === k), onclick: () => { ui.agenda = k; route(); } }, l)));
  const out = [header('Takvim', ui.agenda === 'hafta' ? 'Önümüzdeki 14 gün' : 'Dönemin önemli tarihleri'), seg];
  if (ui.agenda === 'hafta') {
    out.push(h('div.chips', h('button.chip', { type: 'button', 'aria-pressed': String(ui.onlyExams), onclick: () => { ui.onlyExams = !ui.onlyExams; route(); } }, 'Sadece sınav ve quizler')));
    const m = nowMin();
    for (let i = 0; i < 14; i++) {
      const d = addDays(today(), i), di = iso(d);
      const rows = [];
      if (!ui.onlyExams) for (const c of classesOn(d)) {
        rows.push({ at: c.start, el: h('li.ag.cls' + (c.change && c.change.kind === 'iptal' ? '.cancel' : ''), { style: { '--c': color(c.course), opacity: i === 0 && m >= mins(c.end) ? '.5' : null } },
          h('div.tm', c.start, h('small', c.end)),
          h('div.bd', h('b', cname(c.course)), c.kind !== 'Ders' ? ' · ' + kindLabel(c) : '',
            c.change ? [' ', kindTag(c.change.kind)] : null,
            h('div.sub', `${c.room}${c.instructor ? ' · ' + c.instructor : ''}${c.change && c.change.note ? ' · ' + c.change.note : ''}`))) });
      }
      for (const t of TODOS.filter((t) => t.date === di && (!ui.onlyExams || t.urgent))) {
        rows.push({ at: hasTime(t.time) ? t.time : '23:59', el: h('li.ag' + (t.urgent ? '.duex' : ''),
          h('div.tm', hasTime(t.time) ? t.time : 'gün içi'),
          h('div.bd', lower(t.verb).startsWith(lower(kindTag(t.kind).textContent)) ? null : kindTag(t.kind), h('b', t.verb), t.what ? ' · ' + t.what : '', h('div.sub', cname(t.course) + (t.note ? ' · ' + t.note : '')))) });
      }
      for (const x of (D.deadlines || []).filter((r) => r.kind === 'tatil' && r.date <= di && (r.end || r.date) >= di)) {
        rows.push({ at: '00:00', el: h('li.ag', h('div.tm', 'tüm gün'), h('div.bd', kindTag('tatil'), x.title)) });
      }
      if (!rows.length && (ui.onlyExams || wd(d) >= 6)) continue;
      rows.sort((a, b) => a.at.localeCompare(b.at));
      out.push(h('div.dayhead', h('b', i === 0 ? 'Bugün' : i === 1 ? 'Yarın' : cap(fmt(d, { weekday: 'long' }))), h('span', fmt(d, { day: 'numeric', month: 'long' }))));
      out.push(rows.length ? h('ul.list', rows.map((r) => r.el)) : h('div.card.pad.muted', 'Ders yok.'));
    }
  } else {
    const list = (D.deadlines || []).filter((r) => ['akademik', 'tatil'].includes(r.kind) && (r.end || r.date) >= iso(today()));
    const byMonth = new Map();
    list.forEach((r) => { const k = r.date.slice(0, 7); byMonth.set(k, [...(byMonth.get(k) || []), r]); });
    for (const [k, rows] of byMonth) {
      out.push(sec(fmt(day(k + '-01'), { month: 'long', year: 'numeric' })));
      out.push(h('ul.list', rows.map((r) => h('li', h('div', kindTag(r.kind), h('b', fmt(day(r.date), { day: 'numeric', month: 'short' }) + (r.end ? ' – ' + fmt(day(r.end), { day: 'numeric', month: 'short' }) : ''))),
        h('div.small', { style: { marginTop: '4px' } }, r.title)))));
    }
    out.push(h('p.small.muted', 'Kaynak: ÖİDB akademik takvimi (sadece öğrenciyi ilgilendiren satırlar).'));
  }
  return out;
}

// ---------------------------------------------------------------- Dersler
function courseStatus(c) {
  const t0 = today(), m = nowMin();
  let nc = null;
  for (let i = 0; i < 8 && !nc; i++) { const d = addDays(t0, i); const l = classesOn(d).filter((x) => x.course === c && attends(x) && (i > 0 || mins(x.end) > m)); if (l.length) nc = { d, x: l[0], i }; }
  const todo = TODOS.filter((t) => t.course === c && !t.info && !DONE.has(t.id));
  return { nc, exam: todo.find((t) => t.urgent), task: todo.find((t) => !t.urgent), fresh: recentFeed(72).filter((r) => r.course === c && !SEEN.has(msgId(r))).length, att: (D.attendance || []).filter((a) => a.course === c) };
}
function Courses() {
  return [header('Dersler', 'Bu dönem'),
    h('ul.list', ORDER.map((c) => {
      const s = courseStatus(c);
      return h('li', { style: { padding: 0 } }, h('a.crow', { href: `#ders/${slug(c)}` },
        h('span.stripe', { style: { background: color(c) } }),
        h('span', h('span.nm', cname(c)), h('span.cd', c),
          h('span.ln',
            s.nc ? h('span', `Sonraki ders: ${s.nc.i === 0 ? 'bugün' : s.nc.i === 1 ? 'yarın' : fmt(s.nc.d, { weekday: 'long' })} ${s.nc.x.start}, ${s.nc.x.room}`) : null,
            s.exam ? h('span.warn', `${s.exam.verb}${s.exam.what ? ': ' + s.exam.what : ''} — ${when(s.exam.date)}${daysTo(s.exam.date) > 1 ? ' (' + left(s.exam.date) + ')' : ''}`) : null,
            s.task ? h('span', `${s.task.verb}: ${s.task.what.slice(0, 44)}${s.task.what.length > 44 ? '…' : ''} — ${left(s.task.date)}`) : null,
            s.att.length ? h('span.dim', `Yoklama %${Math.round(s.att[0].percent)}${s.att[0].limit ? ' · şart %' + s.att[0].limit : ''}`) : null)),
        s.fresh ? h('span.badge', `${s.fresh} yeni`) : h('span.side', '›')));
    }))];
}

function Course(c, tab) {
  if (!COURSES[c]) return Courses();
  const s = courseStatus(c);
  const tabs = [['ozet', 'Özet'], ['duyuru', 'Duyuru ve mail'], ['not', 'Notlar'], ['program', 'Program'], ['kaynak', 'Kaynaklar']];
  const meta = (D.courses || []).find((x) => x.course === c) || {};
  const out = [h('a.back', { href: '#dersler' }, '‹ Dersler'), header(c + (meta.ects ? ` · ${meta.ects.replace('.00', '')} AKTS` : ''), cname(c)),
    h('nav.tabs', tabs.map(([k, l]) => h('a', { href: `#ders/${slug(c)}/${k}`, 'aria-current': k === tab ? 'page' : null }, l)))];
  const rerender = () => route();

  if (tab === 'ozet') {
    const todos = TODOS.filter((t) => t.course === c);
    out.push(sec('Sıradaki ders'));
    out.push(s.nc ? h('div.card.pad', h('b', `${cap(s.nc.i === 0 ? 'bugün' : s.nc.i === 1 ? 'yarın' : fmt(s.nc.d, { weekday: 'long' }))} ${s.nc.x.start}–${s.nc.x.end}`),
      ` · ${kindLabel(s.nc.x)}`, h('div.small.muted', `${s.nc.x.room}${s.nc.x.instructor ? ' · ' + s.nc.x.instructor : ''}`)) : h('div.card.pad.muted', 'Programda yok.'));
    out.push(sec('Yapılacaklar'));
    out.push(todos.length ? h('ul.list', todos.map((t) => taskItem(t, rerender))) : h('div.card.pad.muted', '4 hafta içinde kayıtlı bir iş yok.'));
    if (s.att.length) {
      out.push(sec('Yoklama'));
      out.push(h('ul.list', s.att.map((a) => h('li', h('div.kv', h('span', a.page), h('b', '%' + Math.round(a.percent))),
        h('div.meter', h('i' + (a.limit && a.percent < a.limit ? '.low' : ''), { style: { width: Math.min(100, a.percent) + '%' } }), a.limit ? h('b', { style: { left: a.limit + '%' } }) : null),
        a.limit ? h('div.small.muted', { style: { marginTop: '6px' } }, `Devam şartı %${a.limit} (ders ve recitation ayrı ayrı)`) : null))));
    }
    const last = (D.feed || []).filter((r) => r.course === c).slice(0, 3);
    out.push(sec('Son duyurular', ['Tümü', `#ders/${slug(c)}/duyuru`]));
    out.push(last.length ? h('ul.list', last.map(messageItem)) : h('div.card.pad.muted', 'Son 60 günde yok.'));
  } else if (tab === 'duyuru') {
    const l = (D.feed || []).filter((r) => r.course === c);
    out.push(l.length ? h('ul.list', { style: { marginTop: '12px' } }, l.map(messageItem)) : h('div.card.pad.muted', 'Son 60 günde yok.'));
  } else if (tab === 'not') {
    const g = (D.grades || []).filter((x) => x.course === c);
    const pages = [...new Set(g.map((x) => x.page))];
    if (!g.length) out.push(h('div.card.pad.muted', { style: { marginTop: '12px' } }, 'Henüz not girilmemiş.'));
    for (const p of pages) {
      out.push(sec(['Pratix', 'Peercept'].includes(p) ? p : 'ODTÜClass · ' + p.replace(c + ' ', '')));
      out.push(h('ul.list', g.filter((x) => x.page === p).map((x) => h('li', h('div.kv', h('span', x.item), h('b' + (x.graded ? '' : '.none'), x.grade && x.grade !== '-' ? x.grade : 'girilmedi'))))));
    }
  } else if (tab === 'program') {
    const l = (D.schedule || []).filter((x) => x.course === c);
    out.push(h('ul.list', { style: { marginTop: '12px' } }, l.map((x) => h('li', h('div.kv', h('b', `${x.day} ${x.start}–${x.end}`), h('span.muted', kindLabel(x))),
      h('div.small.muted', `${x.room}${x.instructor ? ' · ' + x.instructor : ''}${x.section ? ' · şube ' + x.section : ''}`)))));
    const prof = (D.profile || {})[c];
    if (prof) out.push(h('p.small.muted', 'Profil: ' + Object.entries(prof).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')));
  } else {
    const links = (D.links || []).filter((l) => l.course === c || l.label === 'ODTÜClass');
    out.push(sec('Bağlantılar'), h('div.links', links.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.label + ' ↗'))));
    const files = (D.files || []).filter((f) => f.course === c);
    out.push(sec('Bilgisayarındaki son dosyalar'));
    out.push(files.length ? h('ul.list', files.slice(0, 20).map((f) => h('li', h('div.kv', h('span', { style: { overflowWrap: 'anywhere' } }, f.file.split('/').pop()),
      h('span.small.muted', fmt(new Date(f.at), { day: 'numeric', month: 'short' }))), h('div.small.muted', f.file.includes('/') ? f.file.split('/').slice(0, -1).join(' / ') : 'ayıklanmayı bekliyor')))) : h('div.card.pad.muted', 'Son 3 haftada yeni dosya yok.'));
  }
  return out;
}

// ---------------------------------------------------------------- Gelen
function Inbox() {
  const opts = [['', 'Hepsi'], ...ORDER.map((c) => [c, cname(c)]), ['Genel', 'ODTÜ / bölüm']];
  const box = h('div');
  const draw = () => {
    const q = lower(ui.q);
    const rows = (D.feed || []).filter((r) => (!ui.feedCourse || r.course === ui.feedCourse) && (!q || lower(`${r.title} ${r.text} ${r.from}`).includes(q))).slice(0, 200);
    const byDay = new Map();
    rows.forEach((r) => { const k = r.at.slice(0, 10); byDay.set(k, [...(byDay.get(k) || []), r]); });
    put(box, rows.length ? [...byDay].map(([k, l]) => [h('div.dayhead', h('b', cap(when(k))), h('span', `${l.length} mesaj`)), h('ul.list', l.map(messageItem))])
      : h('div.card.pad.muted', 'Eşleşen duyuru ya da mail yok.'));
  };
  draw();
  return [header('Gelen', 'Duyuru ve mailler · son 60 gün'),
    h('input.search', { type: 'search', placeholder: 'Ara: midterm, quiz, sınıf…', 'aria-label': 'Ara', value: ui.q, oninput: (e) => { ui.q = e.target.value; draw(); } }),
    h('div.chips', opts.map(([k, l]) => h('button.chip', { type: 'button', 'aria-pressed': String(ui.feedCourse === k), onclick: () => { ui.feedCourse = k; route(); } }, k && COURSES[k] ? dot(k) : null, l))),
    box];
}

// ---------------------------------------------------------------- Kampüs
function Campus() {
  const out = [header('Kampüs', 'Yemekhane ve ring'),
    h('div.seg', [['yemek', 'Yemek'], ['ring', 'Ring']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(ui.kampus === k), onclick: () => { ui.kampus = k; route(); } }, l)))];
  if (ui.kampus === 'yemek') {
    const days = [...new Set((D.menu || []).map((m) => m.date))].filter((d) => daysTo(d) >= 0);
    if (!days.includes(ui.gun)) ui.gun = days.includes(iso(today())) ? iso(today()) : days[0];
    out.push(h('div.chips', days.map((d) => h('button.chip', { type: 'button', 'aria-pressed': String(ui.gun === d), onclick: () => { ui.gun = d; route(); } },
      daysTo(d) === 0 ? 'Bugün' : daysTo(d) === 1 ? 'Yarın' : fmt(day(d), { weekday: 'short', day: 'numeric' })))));
    const l = meals(ui.gun);
    out.push(l.length ? h('ul.list', l.map((m) => h('li.meal', h('h3', m.meal), h('ul.dishes', m.dishes.split(', ').map((x) =>
      h('li', photo(x) ? h('img', { src: photo(x), alt: '', loading: 'lazy' }) : h('span.noimg'), h('span', cap(lower(x)))))),
      m.veg ? h('div.veg', 'Vejetaryen: ' + lower(m.veg)) : null))) : h('div.card.pad.muted', 'Bu gün için menü yok.'));
    out.push(h('p.small.muted', 'Öğle 11:30–14:00 (hafta sonu 12:00) · Akşam 17:00–18:30 · Fotoğraflar: kafeterya.metu.edu.tr'));
  } else {
    const stops = Object.keys((D.ring || {}).stops || {});
    const sel = h('select.search', { 'aria-label': 'Durak', onchange: (e) => { store.set('odtu-stop', e.target.value); route(); } },
      stops.map((s) => h('option', { value: s, selected: s === myStop() }, trStop(s))));
    const deps = departures(myStop(), 12);
    out.push(h('label.small.muted', { style: { display: 'block', margin: '2px 2px 6px' } }, 'Durağın'), sel);
    if (ringStale()) out.push(h('div.banner.info.small', `Saat tablosu ${fmt(day(D.ring.valid_until), { month: 'long', year: 'numeric' })} sonuna kadar geçerli olarak yayınlanmış; bu dönem küçük farklar olabilir.`));
    out.push(sec(`${trStop(myStop())} · sıradaki kalkışlar`));
    out.push(deps.length ? h('ul.list', deps.map((d) => h('li', h('div.kv', h('span.cname', h('i.cdot', { style: { background: d.route.color } }), h('b', d.t), ' ', d.route.name),
      h('span' + (d.in <= 10 ? '.due.soon' : '.muted'), d.in === 0 ? 'şimdi' : `${inMin(d.in)} sonra`)))))
      : h('div.card.pad.muted', 'Bugün bu duraktan başka sefer yok.'));
    out.push(sec('Hatlar'));
    out.push(h('ul.list', (D.rings || []).map((r) => h('li', h('details.ring', h('summary', h('b', r.ring), h('span.small.muted', r.times)), h('p', `${r.route}${r.end ? ' → ' + r.end : ''}`))))));
    out.push(h('p.small.muted', 'Saatler: METU App açık verisi (github.com/metuapp/metuapp-files) · hat bilgisi: route.metu.edu.tr'));
  }
  return out;
}

// ---------------------------------------------------------------- Ayarlar
function Settings() {
  const t = (s) => (s ? new Date(s).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  return [h('a.back', { href: '#bugun' }, '‹ Bugün'), header('', 'Ayarlar'),
    h('ul.list',
      h('li', h('div.kv', h('span', 'Veri güncellendi'), h('b', t(D.generated)))),
      h('li', h('div.kv', h('span', 'Mailler en son okundu'), h('b', t(D.messages_read_at)))),
      h('li.small.muted', 'Her sabah: ODTÜClass, okul maili, SAIS, Pratix, Peercept, kafeterya, ring ve akademik takvim çekilir; ardından Claude yeni ders mesajlarını okuyup tarihleri günceller.')),
    h('div', { style: { display: 'grid', gap: '10px', marginTop: '16px' } },
      h('button.btn.ghost', { type: 'button', onclick: () => location.reload() }, 'Verileri yeniden yükle'),
      h('button.btn.ghost', { type: 'button', onclick: () => { DONE.clear(); store.set('odtu-done', []); route(); } }, 'İşaretlediğim işleri sıfırla'),
      LOCAL ? null : h('button.btn.ghost', { type: 'button', onclick: async () => { await IDB.del('key'); location.hash = ''; location.reload(); } }, 'Bu cihazda kilitle'))];
}

// ---------------------------------------------------------------- boot
if ('serviceWorker' in navigator && !LOCAL) navigator.serviceWorker.register('sw.js').catch(() => {});
load();
