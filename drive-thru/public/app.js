import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, query, orderBy, limit, onSnapshot,
  writeBatch, updateDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, locationLabel } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const MIN = 60000, STALE = 3 * 60 * MIN, RECENT = 90 * MIN;
let db = null, trips = [], me = null, busy = false, loaded = false, agoMin = 0, note = "", authFailed = false;

if (locationLabel) $("loc").textContent = locationLabel;

const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const mins = (ms) => Math.max(0, Math.round(ms / MIN));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

function model() {
  const now = Date.now();
  const valid = trips.filter((t) => typeof t.arrivedAt === "number" && t.arrivedAt <= now + MIN);
  const open = valid.filter((t) => !t.leftAt && now - t.arrivedAt < STALE);
  const done = valid.filter((t) => t.leftAt && t.leftAt > t.arrivedAt && t.leftAt - t.arrivedAt < STALE)
    .map((t) => ({ ...t, dur: t.leftAt - t.arrivedAt }));
  const today = done.filter((t) => t.arrivedAt >= startOfDay());
  const recent = done.filter((t) => now - t.leftAt < RECENT).sort((a, b) => b.leftAt - a.leftAt).slice(0, 10);
  const longestOpen = open.reduce((m, t) => Math.max(m, now - t.arrivedAt), 0);

  let est = null, conf = "No data yet", why = "";
  if (recent.length) {
    est = median(recent.map((t) => t.dur));
    conf = recent.length >= 5 ? "Solid estimate" : recent.length >= 2 ? "Rough estimate" : "Early guess";
    why = `Typical of the last ${recent.length} car${recent.length > 1 ? "s" : ""} through in the past 90 minutes.`;
  } else if (today.length) {
    est = median(today.map((t) => t.dur));
    conf = "Older data";
    why = `No one has checked out in 90 minutes, so this uses all ${today.length} timed car${today.length > 1 ? "s" : ""} from today.`;
  }
  if (longestOpen > MIN && (est === null || longestOpen > est)) {
    const was = est;
    est = longestOpen;
    why = (was === null ? "Nobody has checked out yet. " : "") + `A car still in line has already waited ${mins(longestOpen)} min, so the wait is at least that long.`;
    if (conf === "No data yet") conf = "Early guess";
  }
  return { now, open, done, today, recent, est, conf, why };
}

function renderSign(m) {
  $("est").innerHTML = (m.est === null ? "--" : mins(m.est)) + "<small>min</small>";
  $("why").textContent = m.est === null
    ? (loaded ? "No one has checked in yet. Be the first: tap “I'm in line” below." : "Loading check-ins…")
    : m.why;
  $("conf").textContent = m.conf;
}

function renderStats(m) {
  $("sInLine").textContent = m.open.length;
  $("sDone").textContent = m.today.length;
  const durs = m.today.map((t) => t.dur);
  $("sAvg").textContent = durs.length ? mins(median(durs)) + "m" : "–";
  $("sRange").textContent = durs.length ? `${mins(Math.min(...durs))}/${mins(Math.max(...durs))}` : "–";
}

function renderChart(m) {
  const pts = m.today, opens = m.open.filter((t) => t.arrivedAt >= startOfDay());
  if (!pts.length && !opens.length) { $("chartBox").innerHTML = '<p class="empty">The chart fills in once the first car checks out.</p>'; return; }
  const W = 520, H = 200, L = 34, R = 10, T = 10, B = 26;
  const all = [...pts.map((t) => t.arrivedAt), ...opens.map((t) => t.arrivedAt)];
  let x0 = Math.min(...all), x1 = Math.max(m.now, ...all);
  if (x1 - x0 < 60 * MIN) x0 = x1 - 60 * MIN;
  const ymaxRaw = Math.max(10, ...pts.map((t) => t.dur / MIN), ...opens.map((t) => (m.now - t.arrivedAt) / MIN));
  const step = ymaxRaw > 60 ? 20 : ymaxRaw > 30 ? 10 : 5, ymax = Math.ceil(ymaxRaw / step) * step;
  const sx = (t) => L + ((t - x0) / (x1 - x0)) * (W - L - R), sy = (v) => H - B - (v / ymax) * (H - T - B);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Each timed car plotted by arrival time and wait in minutes">`;
  for (let v = 0; v <= ymax; v += step) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/><text x="${L - 6}" y="${sy(v) + 4}" text-anchor="end">${v}</text>`;
  const span = x1 - x0, tickEvery = span > 6 * 60 * MIN ? 120 * MIN : span > 3 * 60 * MIN ? 60 * MIN : 30 * MIN;
  for (let t = Math.ceil(x0 / tickEvery) * tickEvery; t <= x1; t += tickEvery) s += `<text x="${sx(t)}" y="${H - 6}" text-anchor="middle">${fmtClock(t)}</text>`;
  pts.forEach((t) => { s += `<circle class="dot" cx="${sx(t.arrivedAt)}" cy="${sy(t.dur / MIN)}" r="4.5"><title>Arrived ${fmtClock(t.arrivedAt)}, waited ${mins(t.dur)} min</title></circle>`; });
  opens.forEach((t) => { s += `<circle class="open" cx="${sx(t.arrivedAt)}" cy="${sy((m.now - t.arrivedAt) / MIN)}" r="4.5"><title>Still in line, ${mins(m.now - t.arrivedAt)} min so far</title></circle>`; });
  s += `<text x="${L}" y="${T + 2}" dy="-2" text-anchor="start" style="font-size:10px">min</text></svg>`;
  s += `<p class="hint">Filled dots are finished visits. Hollow amber dots are cars still in line.</p>`;
  $("chartBox").innerHTML = s;
}

function renderLog(m) {
  const rows = [...m.open.map((t) => ({ ...t, live: true })), ...m.done]
    .sort((a, b) => b.arrivedAt - a.arrivedAt).slice(0, 15);
  if (!rows.length) { $("log").innerHTML = '<li><span class="empty">No check-ins yet. Tap “I\'m in line” when you join the queue.</span></li>'; return; }
  $("log").innerHTML = rows.map((t) => {
    const youTag = t.uid && t.uid === me ? '<span class="pill you">You</span> ' : "";
    const mid = t.live ? `${youTag}<span class="pill">In line</span>` : `${youTag}<span class="hint">Left ${fmtClock(t.leftAt)}</span>`;
    const d = t.live ? `${mins(m.now - t.arrivedAt)} min so far` : `${mins(t.dur)} min`;
    return `<li><span class="t">${fmtClock(t.arrivedAt)}</span><span>${mid}</span><span class="d">${d}</span></li>`;
  }).join("");
}

const myOpen = (m) => (me ? m.open.find((t) => t.uid === me) : null);

function renderMine(m) {
  const box = $("mine");
  if (!me) {
    box.dataset.state = "noauth";
    box.innerHTML = `<h2>Your visit</h2><p class="hint">${authFailed ? "Check-ins are unavailable right now. You can still see the wait times." : "Connecting…"}</p>`;
    return;
  }
  const mine = myOpen(m);
  const msg = note ? `<p class="msg">${esc(note)}</p>` : "";
  if (mine) {
    if (box.dataset.state !== "in:" + mine.id) {
      box.dataset.state = "in:" + mine.id;
      box.innerHTML = `<h2>You're in line</h2>
        <div class="timer-row"><div class="timer" id="timer">0:00</div><div class="hint live">Since ${fmtClock(mine.arrivedAt)}</div></div>
        <button class="btn alt" id="out">I got my food</button>
        <button class="link" id="cancel">I left without ordering (remove my check-in)</button>
        <div id="mmsg"></div>`;
      $("out").onclick = () => checkOut(mine.id);
      $("cancel").onclick = () => cancel(mine.id);
    }
    tickTimer(mine);
    $("mmsg").innerHTML = msg;
    $("out").disabled = busy;
    return;
  }
  const st = "idle:" + agoMin + ":" + busy + ":" + note;
  if (box.dataset.state === st) return;
  box.dataset.state = st;
  const opts = [[0, "Just now"], [5, "5 min ago"], [10, "10 min ago"], [15, "15 min ago"], [20, "20 min ago"], [30, "30 min ago"]];
  box.innerHTML = `<h2>Pulling into the line?</h2>
    <p class="hint">Tap in when you join the queue and tap out when you have your food. Your time helps everyone behind you.</p>
    <div class="ago" role="group" aria-label="When did you get in line?">${opts.map(([v, l]) => `<button data-ago="${v}" aria-pressed="${v === agoMin}">${l}</button>`).join("")}</div>
    <button class="btn" id="in" ${busy ? "disabled" : ""}>I'm in line</button>${msg}`;
  box.querySelectorAll("[data-ago]").forEach((b) => (b.onclick = () => { agoMin = +b.dataset.ago; renderMine(model()); }));
  $("in").onclick = checkIn;
}

function tickTimer(mine) {
  const el = $("timer"); if (!el) return;
  const s = Math.max(0, Math.floor((Date.now() - mine.arrivedAt) / 1000));
  const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  el.textContent = h ? `${h}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

function render() { const m = model(); renderSign(m); renderStats(m); renderChart(m); renderLog(m); renderMine(m); }

function failed(e, what) {
  note = e && e.code === "permission-denied"
    ? (what === "check you in" ? "You checked in a few minutes ago. Wait a bit before checking in again." : `Couldn't ${what}.`)
    : `Couldn't ${what}. Check your connection and try again.`;
}

async function checkIn() {
  if (busy || !me) return;
  if (myOpen(model())) return;
  busy = true; note = ""; render();
  try {
    // The trip and a per-device rate-limit stamp are written together; the
    // security rules reject a trip that doesn't come with a fresh stamp.
    const batch = writeBatch(db);
    const tripRef = doc(collection(db, "trips"));
    batch.set(tripRef, { uid: me, arrivedAt: Date.now() - agoMin * MIN, leftAt: null, createdAt: serverTimestamp() });
    batch.set(doc(db, "limits", me), { at: serverTimestamp() });
    await batch.commit();
    agoMin = 0;
  } catch (e) { console.error(e); failed(e, "check you in"); }
  busy = false; render();
}
async function checkOut(id) {
  if (busy) return;
  busy = true; note = ""; render();
  try { await updateDoc(doc(db, "trips", id), { leftAt: Date.now() }); }
  catch (e) { console.error(e); failed(e, "check you out"); }
  busy = false; render();
}
async function cancel(id) {
  if (busy) return;
  busy = true; note = ""; render();
  try { await deleteDoc(doc(db, "trips", id)); }
  catch (e) { console.error(e); failed(e, "remove your check-in"); }
  busy = false; render();
}

function start() {
  render();
  if (String(firebaseConfig.projectId).startsWith("REPLACE")) {
    loaded = true; authFailed = true;
    $("why").textContent = "This board isn't connected to a database yet. Add the Firebase config in firebase-config.js.";
    render();
    return;
  }
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  const auth = getAuth(app);
  onAuthStateChanged(auth, (u) => { if (u) { me = u.uid; render(); } });
  signInAnonymously(auth).catch((e) => { console.error(e); authFailed = true; render(); });

  const timeout = setTimeout(() => { loaded = true; $("why").textContent = "Still connecting. Live times will appear as soon as the board loads."; }, 10000);
  onSnapshot(query(collection(db, "trips"), orderBy("arrivedAt", "desc"), limit(400)), (snap) => {
    clearTimeout(timeout);
    trips = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    loaded = true; render();
  }, (e) => { console.error(e); clearTimeout(timeout); loaded = true; $("why").textContent = "Couldn't load check-ins. Reload the page to try again."; });
}

setInterval(() => { const mine = myOpen(model()); if (mine) tickTimer(mine); }, 1000);
setInterval(render, 15000);
start();
