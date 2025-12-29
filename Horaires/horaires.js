"use strict";

/* ============================
   CONFIG
   ============================ */
const MIN_TRANSFER_MINUTES = 3;

// "Alternatives" (si un direct existe) — tu peux ajuster
const ALLOW_ALTERNATIVES_WITH_DIRECT = true;
const MAX_WAIT_FOR_ALTERNATIVE = 12; // minutes
const MAX_EXTRA_ARRIVAL = 20;        // minutes
const MAX_ALTERNATIVES_TO_KEEP = 2;  // nb max alternatives gardées

// Classe de gares (pour le ranking correspondances)
const ALLOWED_TRANSFER_CLASSES = new Set([1, 2]); // 1 et 2 seulement

/* ============================
   STATE
   ============================ */
let routes = [];
let stationsAll = [];
let lastRenderedTrips = [];      // trips actuellement affichés (main list)
let lastSearchContext = { from: "", to: "", mode: "home" }; // mode: "home" | "search"
let liveRAF = null;
let stationsIndex = []; // [{ name, key, compact }]
let stationPickerOpen = false;
let stationPickerTarget = null; // inputEl cible (from/to)
/* ===== modal state ===== */
let modalOpen = false;
let modalTrip = null;
let modalFrom = "";
let modalTo = "";
let modalGeom = null; // { x, yStart, yEnd }
let lastPastTrips = []; // pour que le modal marche aussi sur les relations passées
let modalTab = "overview"; // "overview" | "leg1" | "leg2"

/* ============================
   DOM
   ============================ */
const $ = (id) => document.getElementById(id);

/* ============================
   UTILS
   ============================ */
function escapeHtml(str){
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function normalizeKey(s){ return String(s || "").trim().toLowerCase(); }

// ============
// FUZZY station matching
// ============

// enlève les accents: É -> E, à -> a, etc.
function stripDiacritics(s){
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// normalise pour la recherche station (accents, St, ponctuation)
function normalizeStationQuery(s){
  let x = stripDiacritics(String(s || "").trim().toLowerCase());

  // séparateurs -> espaces
  x = x.replace(/[-'’.,()/]/g, " ");

  // collapse spaces
  x = x.replace(/\s+/g, " ").trim();

  // "st" -> "saint" (au début d’un token)
  // ex: "st maurice" / "stmaurice" / "st-maurice"
  x = x.replace(/\bst\b/g, "saint");
  x = x.replace(/\bst(?=[a-z])/g, "saint"); // stmaurice -> saintmaurice

  return x;
}

// version "compact" (ignore espaces)
function compactKey(s){
  return String(s || "").replace(/\s+/g, "");
}

// petite distance d’édition (typos)
function levenshtein(a,b){
  a = String(a || ""); b = String(b || "");
  const n = a.length, m = b.length;
  if(n === 0) return m;
  if(m === 0) return n;

  const dp = new Array(m + 1);
  for(let j=0;j<=m;j++) dp[j] = j;

  for(let i=1;i<=n;i++){
    let prev = dp[0];
    dp[0] = i;
    for(let j=1;j<=m;j++){
      const tmp = dp[j];
      const cost = (a[i-1] === b[j-1]) ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,      // del
        dp[j-1] + 1,    // ins
        prev + cost     // sub
      );
      prev = tmp;
    }
  }
  return dp[m];
}

function displayTime(t){
  if(!t) return "—";
  const parts = String(t).trim().split(":");
  if(parts.length !== 2) return String(t);
  const h = parseInt(parts[0], 10);
  const m = String(parseInt(parts[1], 10)).padStart(2, "0");
  if(Number.isNaN(h) || Number.isNaN(parseInt(m,10))) return String(t);
  return `${h}:${m}`; // PAS de 0 devant les heures
}

function toMinutes(t){
  if(!t) return null;
  const parts = String(t).trim().split(":");
  if(parts.length !== 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if(Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function toSeconds(t){
  const m = toMinutes(t);
  return (m == null) ? null : m * 60;
}

function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }

function minutesToHuman(min){
  if(min == null || !Number.isFinite(min)) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if(h <= 0) return `${m} min`;
  return `${h} h ${m} min`;
}

function nowSeconds(){
  const mt = $("mockTime");
  if(mt && String(mt.value||"").trim()){
    // mockTime n’a pas de secondes → on garde pile à la minute
    const m = toMinutes(mt.value);
    if(m != null) return m * 60;
  }

  const d = new Date();
  return (
    d.getHours()*3600 +
    d.getMinutes()*60 +
    d.getSeconds() +
    d.getMilliseconds()/1000
  );
}

function uniqueCaseInsensitive(list){
  const seen = new Set();
  const out = [];
  for(const s of list){
    const k = normalizeKey(s);
    if(!k) continue;
    if(!seen.has(k)){
      seen.add(k);
      out.push(String(s).trim());
    }
  }
  return out;
}

/* ============================
   Station classes (ranking correspondances)
   ============================ */
function stationClass(name){
  const n = normalizeKey(name);
  if(n === "brigue" || n === "sion") return 1;
  if(n === "loèche-les-bains" || n === "loeche-les-bains" || n === "saint-maurice") return 3;
  return 2;
}

/* ============================
   Terminus (Direction)
   -> terminus du PREMIER train
   ============================ */
function trainTerminus(route){
  if(!route || !Array.isArray(route.schedule) || route.schedule.length === 0) return "";
  return route.schedule[route.schedule.length - 1].station || "";
}

/* ============================
   LOAD routes.json
   ============================ */
async function loadRoutes(){
  const res = await fetch("../routes.json", { cache:"no-store" });
  if(!res.ok) throw new Error("Impossible de charger routes.json (utilise Go Live).");
  const data = await res.json();

  routes = (Array.isArray(data.routes) ? data.routes : []).map(r => ({
    id: String(r.id ?? ""),
    line: String(r.line ?? ""),
    name: String(r.name ?? ""),
    schedule: Array.isArray(r.schedule) ? r.schedule.map(s => ({
      station: String(s.station ?? "").trim(),
      arr: s.arr ? String(s.arr) : null,
      dep: s.dep ? String(s.dep) : null
    })) : []
  }));

  const all = [];
  for(const r of routes){
    for(const s of r.schedule){
      if(s.station) all.push(s.station);
    }
  }
  stationsAll = uniqueCaseInsensitive(all).sort((a,b)=>a.localeCompare(b, "fr", { sensitivity:"base" }));
  stationsIndex = stationsAll.map(name=>{
    const key = normalizeStationQuery(name);
    return { name, key, compact: compactKey(key) };
  });
}

/* ============================
   SUGGESTIONS
   ============================ */
function filterStations(query){
  const raw = String(query || "").trim();
  if(!raw) return stationsAll.slice(0, 10);

  const q = normalizeStationQuery(raw);
  const qc = compactKey(q);
  if(!q) return stationsAll.slice(0, 10);

  const scored = [];

  for(const st of stationsIndex){
    const k = st.key;
    const kc = st.compact;

    let score = 0;

    // très fort
    if(k === q || kc === qc) score = 1000;
    else if(k.startsWith(q) || kc.startsWith(qc)) score = 900;
    else if(k.includes(q) || kc.includes(qc)) score = 800;
    else {
      // typo tolérée (sur compact)
      const d = levenshtein(qc, kc);
      if(d <= 2) score = 650 - d*60; // d=1 meilleur que d=2
    }

    if(score > 0) scored.push({ name: st.name, score });
  }

  scored.sort((a,b)=> b.score - a.score || a.name.localeCompare(b.name, "fr", { sensitivity:"base" }));
  return scored.slice(0, 10).map(x=>x.name);
}

function bestStationGuess(raw){
  const q = String(raw || "").trim();
  if(!q) return null;

  const suggestions = filterStations(q);
  if(!suggestions.length) return null;

  const best = suggestions[0];

  // Heuristique "confiance" : on corrige si c'est clairement le match attendu
  const qn = compactKey(normalizeStationQuery(q));
  const bObj = stationsIndex.find(x => x.name === best);
  if(!bObj) return best;

  if(bObj.compact === qn) return best;                 // exact (sans espaces)
  if(bObj.compact.startsWith(qn)) return best;         // préfixe très sûr
  if(bObj.compact.includes(qn) && qn.length >= 5) return best; // contient (requête assez longue)

  const d = levenshtein(qn, bObj.compact);
  if(d <= 2 && qn.length >= 6) return best;           // typo plausible sur chaîne assez longue

  return null;
}

function renderSuggest(boxEl, items){
  if(!items.length){
    boxEl.classList.remove("open");
    boxEl.innerHTML = "";
    return;
  }
  boxEl.innerHTML = items.map(st => `
    <div class="suggestItem" data-value="${escapeHtml(st)}">${escapeHtml(st)}</div>
  `).join("");
  boxEl.classList.add("open");
}

function closeSuggest(boxEl){
  boxEl.classList.remove("open");
  boxEl.innerHTML = "";
}

/* ============================
   STATION PICKER (plein écran)
   ============================ */

function openStationPicker(targetInput){
  stationPickerTarget = targetInput;
  stationPickerOpen = true;

  const overlay = $("stationOverlay");
  const search = $("stationSearchInput");
  if(!overlay || !search) return;

  overlay.hidden = false;
  document.body.classList.add("modalOpen");

  // on pré-remplit avec ce que l'user avait dans le champ
  search.value = targetInput.value || "";
  renderStationList(search.value);

  setTimeout(()=>search.focus(), 0);
}

function closeStationPicker(){
  stationPickerOpen = false;
  stationPickerTarget = null;

  const overlay = $("stationOverlay");
  if(overlay) overlay.hidden = true;

  document.body.classList.remove("modalOpen");
}

function groupByFirstLetter(names){
  const groups = new Map();
  for(const n of names){
    const ch = (n[0] || "#").toUpperCase();
    if(!groups.has(ch)) groups.set(ch, []);
    groups.get(ch).push(n);
  }
  return Array.from(groups.entries()).sort((a,b)=>a[0].localeCompare(b[0], "fr"));
}

function renderStationList(filterText){
  const listEl = $("stationList");
  const hintEl = $("stationHint");
  if(!listEl) return;

  const q = String(filterText || "").trim();

  let items = stationsAll;

  if(q){
    const qn = normalizeStationQuery(q);
    const qc = compactKey(qn);

    // filtre simple + robuste
    items = stationsIndex
      .filter(st => st.key.includes(qn) || st.compact.includes(qc))
      .map(st => st.name);

    const guess = bestStationGuess(q);
    if(hintEl) hintEl.textContent = guess ? `Entrée = valider “${guess}”` : "";
  } else {
    if(hintEl) hintEl.textContent = "";
  }

  const grouped = groupByFirstLetter(items);

  listEl.innerHTML = grouped.map(([letter, arr])=>{
    return `
      <div class="stationSection">${escapeHtml(letter)}</div>
      ${arr.map(name => `
        <div class="stationItem" data-station="${escapeHtml(name)}">
          <span>${escapeHtml(name)}</span>
        </div>
      `).join("")}
    `;
  }).join("");

  listEl.querySelectorAll(".stationItem").forEach(el=>{
    el.addEventListener("click", ()=>{
      const st = el.dataset.station;
      if(!st || !stationPickerTarget) return;
      stationPickerTarget.value = st;
      closeStationPicker();
    });
  });
}

function bindSuggest(inputEl, boxEl){
  inputEl.addEventListener("input", ()=>renderSuggest(boxEl, filterStations(inputEl.value)));
  inputEl.addEventListener("focus", ()=>renderSuggest(boxEl, filterStations(inputEl.value)));

  function applyBestGuess(){
    const guess = bestStationGuess(inputEl.value);
    if(guess){
      inputEl.value = guess;
    }
    closeSuggest(boxEl);
  }

  // Entrée => applique le meilleur guess + ferme suggestions
  inputEl.addEventListener("keydown", (e)=>{
    if(e.key === "Enter"){
      e.preventDefault();
      applyBestGuess();
    }
  });

  // Clique ailleurs / blur => applique le meilleur guess
  inputEl.addEventListener("blur", ()=>{
    // petit timeout pour ne pas gêner le click sur une suggestion
    setTimeout(applyBestGuess, 0);
  });

  boxEl.addEventListener("mousedown", (e)=>{
    const item = e.target.closest(".suggestItem");
    if(!item) return;
    inputEl.value = item.dataset.value;
    closeSuggest(boxEl);
  });

  document.addEventListener("mousedown", (e)=>{
    if(e.target === inputEl) return;
    if(boxEl.contains(e.target)) return;
    closeSuggest(boxEl);
  });
}

/* ============================
   ROUTE helpers / segments
   ============================ */
function stationIndex(route, stationLower){
  const sched = route.schedule || [];
  for(let i=0;i<sched.length;i++){
    if(normalizeKey(sched[i].station) === stationLower) return i;
  }
  return -1;
}

function timeAtStopForArr(route, index){
  const s = (route.schedule || [])[index];
  return s ? (s.arr || s.dep || null) : null;
}
function timeAtStopForDep(route, index){
  const s = (route.schedule || [])[index];
  return s ? (s.dep || s.arr || null) : null;
}

function segment(route, fromLower, toLower){
  const iFrom = stationIndex(route, fromLower);
  const iTo = stationIndex(route, toLower);
  if(iFrom === -1 || iTo === -1 || iFrom >= iTo) return null;

  const sched = route.schedule;
  const stopFrom = sched[iFrom];
  const stopTo = sched[iTo];

  const depFrom = stopFrom.dep || stopFrom.arr;
  const arrTo = stopTo.arr || stopTo.dep;

  return {
    route,
    iFrom, iTo,
    depFrom,
    arrTo,
    depFromMin: toMinutes(depFrom),
    arrToMin: toMinutes(arrTo)
  };
}

/* ============================
   SEARCH direct + one change
   ============================ */
function findDirect(fromRaw, toRaw){
  const from = normalizeKey(fromRaw);
  const to = normalizeKey(toRaw);
  const out = [];
  for(const r of routes){
    const seg = segment(r, from, to);
    if(seg) out.push(seg);
  }
  return out;
}

function findOneChange(fromRaw, toRaw){
  const from = normalizeKey(fromRaw);
  const to = normalizeKey(toRaw);

  const out = [];
  const seen = new Set();

  for(const r1 of routes){
    const iFrom1 = stationIndex(r1, from);
    if(iFrom1 === -1) continue;

    for(let iX1 = iFrom1 + 1; iX1 < r1.schedule.length; iX1++){
      const transferName = r1.schedule[iX1].station;
      if(!transferName) continue;
      const xLower = normalizeKey(transferName);

      const leg1 = segment(r1, from, xLower);
      if(!leg1) continue;

      for(const r2 of routes){
        if(String(r2.id) === String(r1.id)) continue;

        const iTo2 = stationIndex(r2, to);
        if(iTo2 === -1) continue;

        const iX2 = stationIndex(r2, xLower);
        if(iX2 === -1 || iX2 >= iTo2) continue;

        // évite une correspondance inutile si r2 passe aussi par "from" avant la gare de correspondance
        const iFromOnR2 = stationIndex(r2, from);
        if(iFromOnR2 !== -1 && iFromOnR2 < iX2 && iFromOnR2 < iTo2){
          continue;
        }

        const leg2 = segment(r2, xLower, to);
        if(!leg2) continue;

        // contrainte temps correspondance min
        const arrXMin = toMinutes(timeAtStopForArr(r1, leg1.iTo));
        const depXMin = toMinutes(timeAtStopForDep(r2, leg2.iFrom));
        let waitMin = null;

        if(arrXMin != null && depXMin != null){
          waitMin = depXMin - arrXMin;
          if(waitMin < MIN_TRANSFER_MINUTES) continue;
        }

        const key = `${r1.id}|${r2.id}|${xLower}|${leg1.depFrom||""}|${leg2.arrTo||""}`;
        if(seen.has(key)) continue;
        seen.add(key);

        out.push({
          leg1,
          leg2,
          transfer: transferName,
          transferIndexOnLeg1: leg1.iTo,
          waitMin
        });
      }
    }
  }

  return out;
}

/* ============================
   Correspondance dot position (% temps EN TRAIN)
   ============================ */
function safeDiff(a,b){
  if(a == null || b == null) return null;
  const d = b - a;
  return Number.isFinite(d) ? d : null;
}

function transferPercentInTrainTime(leg1, leg2){
  const leg1Ride = safeDiff(leg1.depFromMin, leg1.arrToMin);
  const leg2Ride = safeDiff(leg2.depFromMin, leg2.arrToMin);
  if(leg1Ride == null || leg2Ride == null) return null;
  const total = leg1Ride + leg2Ride;
  if(total <= 0) return null;
  return (leg1Ride / total) * 100;
}

function railStopsPercentsHTML(percents){
  const ps = (percents || []).filter(p => Number.isFinite(p));
  if(ps.length === 0) return "";
  return ps.map(p=>{
    const clamped = clamp(p, 5, 95);
    return `<span class="rail__stop" style="left:${clamped}%;"></span>`;
  }).join("");
}

/* ============================
   Filter/rank changes (si direct existe)
   ============================ */
function filterAndRankChanges(changes, directIts, nowMin){
  // 1) poubelle si correspondance trop courte
  const valid = changes.filter(ch => ch.waitMin == null || ch.waitMin >= MIN_TRANSFER_MINUTES);

  // Pour comparer une correspondance, on la compare à la "meilleure directe possible"
  // qui part APRES (ou à) l'heure de départ de la correspondance (pas "après maintenant").
  function bestDirectAfter(depMin){
    let best = null;
    for(const d of directIts){
      if(d.depMin == null || d.arrMin == null) continue;
      if(d.depMin < depMin) continue;
      if(!best || d.arrMin < best.arrMin) best = d;
    }
    return best;
  }

  // 2-3) supprimer si une directe existe ET n'est pas pire,
  // sauf si la correspondance est STRICTEMENT plus courte en durée.
  const kept = [];
  for(const ch of valid){
    const depMin = ch.depMin ?? 0;
    const bestD = bestDirectAfter(depMin);

    // pas de direct possible après ce départ => on garde
    if(!bestD){
      kept.push(ch);
      continue;
    }

    const chDur = ch.durationMin;
    const dDur  = bestD.durationMin;
    const strictlyShorter = (chDur != null && dDur != null && chDur < dDur);

    // ✅ Anti-parasite : si arrivée identique à la meilleure directe, on garde
    // seulement si la correspondance est strictement plus courte (sinon inutile)
    if(ch.arrMin != null && bestD.arrMin != null && ch.arrMin === bestD.arrMin && !strictlyShorter){
      continue;
    }

    const arrivesEarlier = (ch.arrMin != null && ch.arrMin < bestD.arrMin);
    const notTooLate = (ch.arrMin != null && (ch.arrMin - bestD.arrMin) <= MAX_EXTRA_ARRIVAL);

    // "Avant la prochaine directe" = permet de partir avant le prochain direct disponible
    const beforeNextDirect = depMin < bestD.depMin;

    if(strictlyShorter || arrivesEarlier || (beforeNextDirect && notTooLate)){
      kept.push(ch);
    }
  }

  // 4.x) Pour un même couple de trains (r1 + r2), on garde le meilleur point de changement
  // selon: attente minimale, puis gare prioritaire, puis le plus tôt possible dans le sens de marche.
  const byPair = new Map();
  for(const ch of kept){
    const key = ch.leg1.route.id + "|" + ch.leg2.route.id;
    const cur = byPair.get(key);
    if(!cur){
      byPair.set(key, ch);
      continue;
    }

    const wA = cur.waitMin ?? 1e9;
    const wB = ch.waitMin ?? 1e9;

    if(wB < wA){
      byPair.set(key, ch);
      continue;
    }
    if(wB > wA) continue;

    // égalité: priorité de gare (1 = primaire, 2 = secondaire, 3 = tertiaire)
    const pA = stationClass(cur.transferStation);
    const pB = stationClass(ch.transferStation);

    if(pB < pA){
      byPair.set(key, ch);
      continue;
    }
    if(pB > pA) continue;

    // égalité: plus tôt possible (index plus petit sur la leg1)
    const iA = cur.leg1?.iTo ?? 1e9;
    const iB = ch.leg1?.iTo ?? 1e9;
    if(iB < iA) byPair.set(key, ch);
  }

  const unique = Array.from(byPair.values());

  // 4) on garde max 2 correspondances (la directe est gérée séparément)
  unique.sort((a,b)=>{
    // on favorise les temps de trajets les plus courts, puis arrivée plus tôt, puis attente plus courte
    const da = a.durationMin ?? 1e9;
    const db = b.durationMin ?? 1e9;
    if(da !== db) return da - db;

    const aa = a.arrMin ?? 1e9;
    const ab = b.arrMin ?? 1e9;
    if(aa !== ab) return aa - ab;

    return (a.waitMin ?? 1e9) - (b.waitMin ?? 1e9);
  });

  return unique.slice(0,2);
}

/* ============================
   Build trips (render model)
   ============================ */
function buildTrips(directSegs, changeIts){
  const all = [];

  for(const d of directSegs){
    const depMin = d.depFromMin;
    const arrMin = d.arrToMin;
    const durationMin = (depMin != null && arrMin != null) ? (arrMin - depMin) : null;

    all.push({
      kind:"direct",
      route: d.route,
      line: d.route.line,
      dep: d.depFrom,
      arr: d.arrTo,
      depMin, arrMin,
      durationMin,
      transfer: null,
      stopPercents: [],
      // indices pour modal
      leg1: null,
      leg2: null,
      iFrom: d.iFrom,
      iTo: d.iTo
    });
  }

  for(const ch of changeIts){
    const leg1 = ch.leg1;
    const leg2 = ch.leg2;

    const depMin = leg1.depFromMin;
    const arrMin = leg2.arrToMin;
    const durationMin = (depMin != null && arrMin != null) ? (arrMin - depMin) : null;

    all.push({
      kind:"change",
      leg1, leg2,
      route: null,
      line: leg1.route.line,
      dep: leg1.depFrom,
      arr: leg2.arrTo,
      depMin, arrMin,
      durationMin,
      transfer: ch.transfer,
      stopPercents: [transferPercentInTrainTime(leg1, leg2)].filter(p=>p!=null),
      // indices pour modal
      iFrom: null,
      iTo: null
    });
  }

  const big = 1e9;
  all.sort((a,b)=>{
    const aDep = (a.depMin ?? big), bDep = (b.depMin ?? big);
    if(aDep !== bDep) return aDep - bDep;
    const aArr = (a.arrMin ?? big), bArr = (b.arrMin ?? big);
    if(aArr !== bArr) return aArr - bArr;
    if(a.kind !== b.kind) return a.kind === "direct" ? -1 : 1;
    return 0;
  });

  return all;
}

/* ============================
   CARD HTML
   ============================ */
function renderTripCardHTML(t, idx){
  const depSec = toSeconds(t.dep);
  const arrSec = toSeconds(t.arr);

  const subtitle = (t.kind === "direct") ? "Direct" : "Correspondance";
  const durationTxt = (t.durationMin != null) ? minutesToHuman(t.durationMin) : "";

  const firstRoute = (t.kind === "direct") ? t.route : t.leg1.route;
  const title = `Direction ${trainTerminus(firstRoute)}`;

  return `
    <article class="trip"
             data-tripindex="${idx}"
             data-depsec="${depSec ?? ""}"
             data-arrsec="${arrSec ?? ""}">
      <header class="trip__head">
        <span class="lineTag">${escapeHtml(t.line)}</span>
        <span class="trip__title">${escapeHtml(title)}</span>
        <span class="trip__subtitle">${escapeHtml(subtitle)}</span>
      </header>

      <section class="trip__timeline">
        <time class="time time--left">${escapeHtml(displayTime(t.dep))}</time>

        <div class="rail" aria-hidden="true">
          <span class="rail__dot rail__dot--start"></span>
          <span class="rail__dot rail__dot--end"></span>

          ${railStopsPercentsHTML(t.stopPercents)}

          <span class="rail__live" style="left:0%;"></span>
        </div>

        <time class="time time--right">${escapeHtml(displayTime(t.arr))}</time>
      </section>

      <footer class="trip__foot">
        <span class="duration">${escapeHtml(durationTxt)}</span>
        <span></span>
      </footer>
    </article>
  `;
}

/* ============================
   RENDER RESULTS (SEARCH)
   - SEUL le 1er LIVE + FUTURS
   - "relations précédentes" = déjà partis mais pas live
   ============================ */
function renderTrips(trips, fromRaw, toRaw){
  const results = $("results");
  const status = $("status");
  if(!results || !status) return;

  lastSearchContext = { from: fromRaw, to: toRaw, mode: "search" };

  if(trips.length === 0){
    status.textContent = `❌ Aucun chemin trouvé pour ${fromRaw} → ${toRaw}.`;
    results.innerHTML = "";
    lastRenderedTrips = [];
    lastPastTrips = [];
    return;
  }

  const nowMin = Math.floor(nowSeconds()/60);

  const isLive = (t) =>
    t.depMin != null && t.arrMin != null &&
    nowMin >= t.depMin && nowMin <= t.arrMin;

  const isPast = (t) =>
    t.depMin != null && t.depMin < nowMin && !isLive(t);

  const isFuture = (t) =>
    t.depMin != null && t.depMin >= nowMin;

  const past = [];
  const live = [];
  const future = [];

  for(const t of trips){
    if(isPast(t)) past.push(t);
    else if(isLive(t)) live.push(t);
    else if(isFuture(t)) future.push(t);
    else future.push(t);
  }

  past.sort((a,b)=>(a.depMin??-1e9)-(b.depMin??-1e9));
  live.sort((a,b)=>(a.depMin??1e9)-(b.depMin??1e9));
  future.sort((a,b)=>(a.depMin??1e9)-(b.depMin??1e9));

  const firstLive = live.length ? live[0] : null;
  const otherLives = firstLive ? live.filter(t => t !== firstLive) : [];

  const mainList = (firstLive ? [firstLive, ...otherLives] : []).concat(future);

  lastRenderedTrips = mainList;
  lastPastTrips = past;

  status.textContent = `${mainList.length} liaison(s) affichée(s) pour ${fromRaw} → ${toRaw}.`;

  const prevBtn = past.length
    ? `<button class="prevBtn" id="prevBtn" type="button">Relations précédentes (${past.length})</button>`
    : "";

  const prevHtml = past.length
    ? `<div class="prevWrap" id="prevWrap" hidden>
         ${past.map((t,i)=>renderTripCardHTML(t, `past:${i}`)).join("")}
       </div>`
    : "";

  results.innerHTML = `
    <div class="resultsToolbar">${prevBtn}</div>
    ${prevHtml}
    <div class="mainWrap">
      ${mainList.map((t,i)=>renderTripCardHTML(t, i)).join("")}
    </div>
  `;

  const btn = $("prevBtn");
  if(btn){
    btn.addEventListener("click", ()=>{
      const wrap = $("prevWrap");
      if(!wrap) return;

      const opening = wrap.hasAttribute("hidden");
      if(opening){
        wrap.removeAttribute("hidden");
        btn.textContent = "Masquer les relations précédentes";
      } else {
        wrap.setAttribute("hidden", "");
        btn.textContent = `Relations précédentes (${past.length})`;
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
      bindTripCardClicks(); // IMPORTANT: rebinder quand on dévoile
    });
  }

  bindTripCardClicks();
  startLiveAnimation();
}

/* ============================
   HOME: render all routes
   - 1er LIVE en tête
   ============================ */
function routeStartMin(route){
  const first = route.schedule?.[0];
  const t = first?.dep || first?.arr || null;
  const m = toMinutes(t);
  return (m == null) ? 1e9 : m;
}

function buildHomeTrips(){
  const sorted = [...routes].sort((a,b)=> routeStartMin(a) - routeStartMin(b));

  // convert to trip objects
  const trips = sorted.map(r=>{
    const dep = r.schedule?.[0]?.dep || r.schedule?.[0]?.arr || null;
    const arr = r.schedule?.[r.schedule.length-1]?.arr || r.schedule?.[r.schedule.length-1]?.dep || null;

    return {
      kind:"direct",
      route:r,
      line:r.line,
      dep, arr,
      depMin: toMinutes(dep),
      arrMin: toMinutes(arr),
      durationMin: (toMinutes(dep)!=null && toMinutes(arr)!=null) ? (toMinutes(arr)-toMinutes(dep)) : null,
      transfer:null,
      stopPercents: [],
      leg1:null, leg2:null,
      iFrom: 0,
      iTo: (r.schedule?.length ? r.schedule.length-1 : 0)
    };
  });

   // reorder HOME:
  // - premier live
  // - autres lives
  // - futures
  // - passées
  const nowMin = Math.floor(nowSeconds() / 60);

  const isLive = (t) =>
    t.depMin != null && t.arrMin != null &&
    nowMin >= t.depMin && nowMin <= t.arrMin;

  const isPast = (t) =>
    t.arrMin != null && nowMin > t.arrMin;

  const live = trips
    .filter(isLive)
    .sort((a, b) => (a.depMin ?? 1e9) - (b.depMin ?? 1e9));

  const future = trips
    .filter(t => !isLive(t) && !isPast(t))
    .sort((a, b) => (a.depMin ?? 1e9) - (b.depMin ?? 1e9));

  const past = trips
    .filter(isPast)
    .sort((a, b) => (a.depMin ?? 1e9) - (b.depMin ?? 1e9));

  if(live.length === 0){
    // pas de live => futures puis passées
    return [...future, ...past];
  }

  const firstLive = live[0];
  const otherLives = live.slice(1);

  return [firstLive, ...otherLives, ...future, ...past];
}

function renderAllRoutes(){
  const results = $("results");
  const status = $("status");
  if(!results || !status) return;

  lastSearchContext = { from: "", to: "", mode: "home" };

  const homeTrips = buildHomeTrips();
  lastRenderedTrips = homeTrips;

  status.textContent = `Affichage de toutes les routes (${homeTrips.length}).`;

  results.innerHTML = `
    <div class="mainWrap">
      ${homeTrips.map((t,i)=>renderTripCardHTML(t, i)).join("")}
    </div>
  `;

  bindTripCardClicks();
  startLiveAnimation();
}

/* ============================
   CLICK => OPEN MODAL (cards)
   ============================ */
function bindTripCardClicks(){
  document.querySelectorAll(".trip").forEach(card=>{
    card.addEventListener("click", ()=>{
      const id = String(card.dataset.tripindex ?? "");
      const trip = resolveTripFromCardId(id);
      if(!trip) return;

      // modal only really meaningful when search has from/to,
      // but we still allow on home (shows full route as "De — à —" style)
      const fromLabel = lastSearchContext.mode === "search" ? lastSearchContext.from : (trip.kind==="direct" ? trip.route.schedule[0]?.station : trip.leg1.route.schedule[0]?.station) || "—";
      const toLabel   = lastSearchContext.mode === "search" ? lastSearchContext.to   : (trip.kind==="direct" ? trainTerminus(trip.route) : trainTerminus(trip.leg2.route)) || "—";

      openModal(trip, fromLabel, toLabel);
    }, { once:false });
  });
}

function resolveTripFromCardId(id){
  if(/^\d+$/.test(id)){
    const idx = Number(id);
    return lastRenderedTrips[idx] || null;
  }
  const m = /^past:(\d+)$/.exec(id);
  if(m){
    const idx = Number(m[1]);
    return lastPastTrips[idx] || null;
  }
  return null;
}

/* ============================
   MODAL (open/close + events)
   ============================ */
function openModal(trip, fromLabel, toLabel){
  modalTrip = trip;
  modalFrom = fromLabel;
  modalTo = toLabel;
  modalOpen = true;

  const overlay = $("modalOverlay");
  const titleEl = $("modalTitle");
  const subEl = $("modalSub");
  const bodyEl = $("modalBody");
  if(!overlay || !titleEl || !subEl || !bodyEl) return;

  titleEl.textContent = `${fromLabel} → ${toLabel}`;
  const firstRoute = (trip.kind === "direct") ? trip.route : trip.leg1.route;
  subEl.textContent = `${trip.line} · Direction ${trainTerminus(firstRoute)}`;

  bodyEl.innerHTML = renderModalTimeline(trip, fromLabel, toLabel);

  // Onglets + première timeline
  bindModalTabs();
  renderModalTab(modalTab);

  overlay.hidden = false;
  document.body.classList.add("modalOpen");

  requestAnimationFrame(() => {
    updateUserBoundaryTimes();
    layoutModalRail();
    updateModalLive();
  });
}


function closeModal(){
  modalOpen = false;
  modalTrip = null;

  const overlay = $("modalOverlay");
  if(overlay) overlay.hidden = true;
  document.body.classList.remove("modalOpen");
}

function bindModalEvents(){
  const overlay = $("modalOverlay");
  const closeBtn = $("modalCloseBtn");
  if(!overlay) return;

  overlay.addEventListener("mousedown", (e)=>{
    const modal = overlay.querySelector(".modal");
    if(modal && !modal.contains(e.target)) closeModal();
  });

  if(closeBtn) closeBtn.addEventListener("click", closeModal);

  document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape" && overlay && !overlay.hidden) closeModal();
  });
}

/* ============================
   MODAL timeline data build
   ============================ */
function stopObj(s){
  return {
    station: s.station,
    arr: s.arr || null,
    dep: s.dep || null,
    arrMin: toMinutes(s.arr),
    depMin: toMinutes(s.dep)
  };
}

function buildModalStops(trip, fromLabel, toLabel){
  const fromLower = normalizeKey(fromLabel);
  const toLower = normalizeKey(toLabel);

  if(trip.kind === "direct"){
    const r = trip.route;
    const iFrom = stationIndex(r, fromLower);
    const iTo = stationIndex(r, toLower);

    // fallback si la recherche est vide / home
    const safeFrom = (iFrom >= 0) ? iFrom : (trip.iFrom ?? 0);
    const safeTo = (iTo >= 0) ? iTo : (trip.iTo ?? (r.schedule.length-1));

    const pre  = (safeFrom > 0) ? r.schedule.slice(0, safeFrom).map(stopObj) : [];
    const mid  = r.schedule.slice(safeFrom, safeTo+1).map(stopObj);
    const post = (safeTo < r.schedule.length-1) ? r.schedule.slice(safeTo+1).map(stopObj) : [];

    return { pre, mid, post };
  }

  // correspondance
  const r1 = trip.leg1.route;
  const r2 = trip.leg2.route;

  const iFrom1 = trip.leg1.iFrom;
  const iTo1 = trip.leg1.iTo;
  const iFrom2 = trip.leg2.iFrom;
  const iTo2 = trip.leg2.iTo;

  const pre = (iFrom1 > 0) ? r1.schedule.slice(0, iFrom1).map(stopObj) : [];

  const mid1 = r1.schedule.slice(iFrom1, iTo1+1).map(stopObj);
  const mid2 = r2.schedule.slice(iFrom2, iTo2+1).map(stopObj);

  const mid = mid1.concat(mid2.slice(1)); // sans dupliquer la gare de correspondance
  const post = (iTo2 < r2.schedule.length-1) ? r2.schedule.slice(iTo2+1).map(stopObj) : [];

  return { pre, mid, post };
}

function rowTimeText(stop, isFirst, isLast){
  // Comme demandé : origine=dep ; terminus=arr ; intermédiaire=arr
  if(isFirst) return displayTime(stop.dep || stop.arr);
  if(isLast) return displayTime(stop.arr || stop.dep);
  return displayTime(stop.arr || stop.dep);
}

function stopProgressMin(stop, isFirst, isLast){
  // Temps "progression" pour le live :
  // - origine: DEP
  // - terminus: ARR
  // - intermédiaire: ARR (car le train "arrive" à cet instant)
  if(isFirst) return stop.depMin ?? stop.arrMin ?? null;
  if(isLast)  return stop.arrMin ?? stop.depMin ?? null;
  return stop.arrMin ?? stop.depMin ?? null;
}

function setRowTimes(row, mode){
  // mode: "origin" | "terminus" | "middle"
  const arr = row.dataset.arr || "";
  const dep = row.dataset.dep || "";

  let depAligned = "";
  let arrAbove = "";

  if(mode === "origin"){
    depAligned = displayTime(dep || arr || "");
    arrAbove = "";
  } else if(mode === "terminus"){
    depAligned = displayTime(arr || dep || "");
    arrAbove = "";
  } else {
    depAligned = displayTime(dep || "");
    arrAbove = displayTime(arr || "");
  }

  const timeCell = row.querySelector(".vTimeCell");
  if(!timeCell) return;

  timeCell.innerHTML = `
    ${arrAbove ? `<div class="vArrTime">${escapeHtml(arrAbove)}</div>` : ""}
    <div class="vDepTime">${escapeHtml(depAligned)}</div>
  `;

  // IMPORTANT: recalcul tmin (sert au live)
  const isFirst = (mode === "origin");
  const isLast  = (mode === "terminus");
  row.dataset.tmin = stopProgressMin({ arr, dep }, isFirst, isLast) ?? "";
}

function updateUserBoundaryTimes(){
  const wrap = $("modalVWrap");
  if(!wrap) return;

  const user = wrap.querySelector("#userSegment");
  if(!user) return;

  const rows = Array.from(user.querySelectorAll(".vRow"));
  if(rows.length === 0) return;

  const preOpen  = !($("foldPre")?.hasAttribute("hidden") ?? true);
  const postOpen = !($("foldPost")?.hasAttribute("hidden") ?? true);

  const first = rows[0];
  const last  = rows[rows.length - 1];

  // par défaut : cas 1 (toggles fermés) => A=origin, B=terminus
  let firstMode = preOpen ? "middle" : "origin";
  let lastMode  = postOpen ? "middle" : "terminus";

  // exceptions : si c’est VRAIE origine/terminus du train (selon dep/arr)
  if((first.dataset.dep || "") && !(first.dataset.arr || "")) firstMode = "origin";
  if((last.dataset.arr || "") && !(last.dataset.dep || ""))   lastMode = "terminus";

  // applique
  setRowTimes(first, firstMode);

  // si 1 seul stop, évite de l’écraser deux fois
  if(last !== first) setRowTimes(last, lastMode);
}

function modalStopTimeLabel(s, isFirst, isLast){
  // origine = dep ; terminus = arr ; intermédiaire = arr (comme ton code actuel)
  if(isFirst) return displayTime(s.dep || s.arr);
  if(isLast)  return displayTime(s.arr || s.dep);
  return displayTime(s.arr || s.dep);
}

function buildStopsForLeg(route, iFrom, iTo){
  return route.schedule.slice(iFrom, iTo + 1).map(stopObj);
}

function buildModalStopsForLeg(route, iFrom, iTo){
  const pre  = route.schedule.slice(0, iFrom).map(stopObj);
  const mid  = route.schedule.slice(iFrom, iTo + 1).map(stopObj);
  const post = route.schedule.slice(iTo + 1).map(stopObj);
  return { pre, mid, post };
}

function renderModalTimeline(trip, fromLabel, toLabel){
  // Modal "direct" : on garde ton rendu CFF-like (avec toggles pre/post)
  if(trip.kind === "direct"){
    const { pre, mid, post } = buildModalStops(trip, fromLabel, toLabel);

    const toggleRow = (kind, text) => `
      <button class="vToggle" type="button" data-toggle="${escapeHtml(kind)}">
        <span class="vTogglePlus">+</span>
        <span class="vToggleText">${escapeHtml(text)}</span>
      </button>
    `;

    const renderStops = (stops, muted=false) => stops.map((s)=>{
      const isFirst = (s.dep && !s.arr);
      const isLast  = (s.arr && !s.dep);

      let depAligned = "";
      let arrAbove = "";

      if(isFirst){
        depAligned = displayTime(s.dep || s.arr || "");
        arrAbove = "";
      } else if(isLast){
        depAligned = displayTime(s.arr || s.dep || "");
        arrAbove = "";
      } else {
        depAligned = displayTime(s.dep || "");
        arrAbove = displayTime(s.arr || "");
      }

      const tMin = stopProgressMin(s, isFirst, isLast);

      return `
        <div class="vRow ${muted ? "is-muted" : ""}"
          data-arr="${escapeHtml(s.arr || "")}"
          data-dep="${escapeHtml(s.dep || "")}"
          data-tmin="${tMin ?? ""}">
          <div class="vTimeCell">
            ${arrAbove ? `<div class="vArrTime">${escapeHtml(arrAbove)}</div>` : ""}
            <div class="vDepTime">${escapeHtml(depAligned)}</div>
          </div>

          <div class="vLineCol"><span class="vDot"></span></div>
          <div class="vStation">${escapeHtml(s.station)}</div>
        </div>
      `;
    }).join("");

    const preLabel  = pre.length  ? pre[0].station : "";
    const postLabel = post.length ? post[post.length-1].station : "";

    return `
      <div class="vWrap" id="modalVWrap">
        <div class="vRail" id="modalRail"></div>
        <div class="vLive" id="modalLiveDot"></div>

        ${pre.length ? toggleRow("pre", `Itinéraire depuis ${preLabel}`) : ""}
        <div class="vFold" id="foldPre" hidden>
          ${renderStops(pre, true)}
        </div>

        <div id="userSegment">
          ${renderStops(mid, false)}
        </div>

        ${post.length ? toggleRow("post", `Itinéraire jusqu’à ${postLabel}`) : ""}
        <div class="vFold" id="foldPost" hidden>
          ${renderStops(post, true)}
        </div>
      </div>
    `;
  }

  // Modal "correspondance" : nouvelle UI surprise 🎁
  // (on rend un header + onglets, et on injecte la timeline ensuite via renderModalTab)
  const leg1 = trip.leg1;
  const leg2 = trip.leg2;

  const r1 = leg1.route;
  const r2 = leg2.route;

  const transferStation = trip.transfer || r1.schedule?.[leg1.iTo]?.station || "Correspondance";

  const waitMin = (() => {
    const a = toMinutes(timeAtStopForArr(r1, leg1.iTo));
    const d = toMinutes(timeAtStopForDep(r2, leg2.iFrom));
    if(a == null || d == null) return null;
    return d - a;
  })();

  const dep1 = timeAtStopForDep(r1, leg1.iFrom);
  const arr1 = timeAtStopForArr(r1, leg1.iTo);
  const dep2 = timeAtStopForDep(r2, leg2.iFrom);
  const arr2 = timeAtStopForArr(r2, leg2.iTo);

  const dur1 = (toMinutes(dep1)!=null && toMinutes(arr1)!=null) ? (toMinutes(arr1)-toMinutes(dep1)) : null;
  const dur2 = (toMinutes(dep2)!=null && toMinutes(arr2)!=null) ? (toMinutes(arr2)-toMinutes(dep2)) : null;

  return `
    <div class="cxSummary">
      <div class="cxLeg">
        <div class="cxLegTop">
          <span class="cxBadge">${escapeHtml(r1.line)}</span>
          <span class="cxDir">Direction ${escapeHtml(trainTerminus(r1))}</span>
        </div>
        <div class="cxTimes">
          <span class="cxT">${escapeHtml(displayTime(dep1))}</span>
          <span class="cxArrow">→</span>
          <span class="cxT">${escapeHtml(displayTime(arr1))}</span>
        </div>
        <div class="cxMeta">${dur1!=null ? escapeHtml(minutesToHuman(dur1)) : ""}</div>
      </div>

      <div class="cxTransfer">
        <div class="cxTransferTitle">${escapeHtml(transferStation)}</div>
        <div class="cxTransferMeta">
          ${waitMin==null ? "Correspondance" : `Correspondance · ${escapeHtml(minutesToHuman(waitMin))}`}
        </div>
      </div>

      <div class="cxLeg">
        <div class="cxLegTop">
          <span class="cxBadge">${escapeHtml(r2.line)}</span>
          <span class="cxDir">Direction ${escapeHtml(trainTerminus(r2))}</span>
        </div>
        <div class="cxTimes">
          <span class="cxT">${escapeHtml(displayTime(dep2))}</span>
          <span class="cxArrow">→</span>
          <span class="cxT">${escapeHtml(displayTime(arr2))}</span>
        </div>
        <div class="cxMeta">${dur2!=null ? escapeHtml(minutesToHuman(dur2)) : ""}</div>
      </div>
    </div>

    <div class="cxTabs" id="cxTabs">
      <button class="cxTabBtn is-active" type="button" data-tab="overview">Vue d’ensemble</button>
      <button class="cxTabBtn" type="button" data-tab="leg1">${escapeHtml(r1.line)}</button>
      <button class="cxTabBtn" type="button" data-tab="leg2">${escapeHtml(r2.line)}</button>
    </div>

    <div id="modalTimelineHost"></div>
  `;
}

function bindModalTabs(){
  const tabs = document.getElementById("cxTabs");
  if(!tabs) return;

  tabs.querySelectorAll(".cxTabBtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const tab = btn.dataset.tab;
      if(!tab) return;

      modalTab = tab;

      tabs.querySelectorAll(".cxTabBtn").forEach(b=>b.classList.toggle("is-active", b === btn));

      renderModalTab(modalTab);
      requestAnimationFrame(() => {
        updateUserBoundaryTimes();
        layoutModalRail();
        updateModalLive();
      });
    });
  });
}

function renderModalTab(tab){
  if(!modalTrip) return;

  // ✅ direct => déjà rendu dans renderModalTimeline (avec toggles)
  if(modalTrip.kind === "direct"){
    bindModalToggles();
    return;
  }

  const host = document.getElementById("modalTimelineHost");
  if(!host) return;

  const leg1 = modalTrip.leg1;
  const leg2 = modalTrip.leg2;

  const r1 = leg1.route;
  const r2 = leg2.route;

  // Helpers: rendu d’une ligne avec ARR au-dessus + DEP alignée (si pertinent)
  function rowHTML(stop, isFirst, isLast, muted=false){
    // origine => DEP seule
    // terminus => ARR seule
    // intermédiaire => ARR au-dessus + DEP alignée (si dispo)
    let depAligned = "";
    let arrAbove = "";

    if(isFirst){
      depAligned = displayTime(stop.dep || stop.arr || "");
      arrAbove = "";
    } else if(isLast){
      depAligned = displayTime(stop.arr || stop.dep || "");
      arrAbove = "";
    } else {
      depAligned = displayTime(stop.dep || "");
      arrAbove = displayTime(stop.arr || "");
      // si une des 2 manque, on évite d’afficher "—" en doublon
      if(!stop.arr) arrAbove = "";
      if(!stop.dep && stop.arr) depAligned = displayTime(stop.arr || "");
      if(!stop.dep && !stop.arr) depAligned = "—";
    }

    const tMin = stopProgressMin(stop, isFirst, isLast);

    if(arrAbove && depAligned && arrAbove === depAligned){
      arrAbove = "";
    }

    return `
      <div class="vRow ${muted ? "is-muted" : ""}"
        data-arr="${escapeHtml(stop.arr || "")}"
        data-dep="${escapeHtml(stop.dep || "")}"
        data-tmin="${tMin ?? ""}">
        <div class="vTimeCell">
          ${arrAbove ? `<div class="vArrTime">${escapeHtml(arrAbove)}</div>` : ""}
          <div class="vDepTime">${escapeHtml(depAligned)}</div>
        </div>
        <div class="vLineCol"><span class="vDot"></span></div>
        <div class="vStation">${escapeHtml(stop.station)}</div>
      </div>
    `;
  }

  function wrapHTML(inner){
    return `
      <div class="vWrap" id="modalVWrap">
        <div class="vRail" id="modalRail"></div>
        <div class="vLive" id="modalLiveDot"></div>
        ${inner}
      </div>
    `;
  }

  // ------------- TAB: OVERVIEW (pas de boutons, mais ARR+DEP partout)
  if(tab === "overview"){
    const stopsLeg1 = buildStopsForLeg(r1, leg1.iFrom, leg1.iTo);
    const stopsLeg2 = buildStopsForLeg(r2, leg2.iFrom, leg2.iTo);

    // ✅ gare de correspondance (affichée une seule fois) :
    // arr = arrivée train 1 ; dep = départ train 2
    const transferIdx = stopsLeg1.length - 1; // dernier stop de leg1
    const transferStation = stopsLeg1[transferIdx]?.station || "Correspondance";

    const transferStop = {
      station: transferStation,
      arr: timeAtStopForArr(r1, leg1.iTo) || null,
      dep: timeAtStopForDep(r2, leg2.iFrom) || null,
      arrMin: toMinutes(timeAtStopForArr(r1, leg1.iTo)),
      depMin: toMinutes(timeAtStopForDep(r2, leg2.iFrom))
    };

    // on remplace le dernier stop de leg1 par le stop “mixé”, puis on concat leg2 sans dupliquer
    const stops = [
      ...stopsLeg1.slice(0, -1),
      transferStop,
      ...stopsLeg2.slice(1)
    ];

    const html = stops.map((s, idx)=>{
      const isFirst = (idx === 0);
      const isLast  = (idx === stops.length - 1);
      return rowHTML(s, isFirst, isLast, false);
    }).join("");

    host.innerHTML = wrapHTML(`<div id="userSegment">${html}</div>`);
    return; // pas de toggles sur overview
  }

  // ------------- TAB: LEG1 / LEG2 (✅ boutons origine/destination + ARR/DEP)
  const isLeg1 = (tab === "leg1");
  const route = isLeg1 ? r1 : r2;
  const iFrom  = isLeg1 ? leg1.iFrom : leg2.iFrom;
  const iTo    = isLeg1 ? leg1.iTo   : leg2.iTo;

  const { pre, mid, post } = buildModalStopsForLeg(route, iFrom, iTo);

  const toggleRow = (kind, text) => `
    <button class="vToggle" type="button" data-toggle="${escapeHtml(kind)}">
      <span class="vTogglePlus">+</span>
      <span class="vToggleText">${escapeHtml(text)}</span>
    </button>
  `;

  const preLabel  = pre.length  ? pre[0].station : "";
  const postLabel = post.length ? post[post.length-1].station : "";

  const preHTML = pre.map((s, idx)=>{
    // dans le fold, tout est "middle" (on veut ARR+DEP)
    return rowHTML(s, false, false, true);
  }).join("");

  const midHTML = mid.map((s, idx)=>{
    const isFirst = (idx === 0);
    const isLast  = (idx === mid.length - 1);
    return rowHTML(s, isFirst, isLast, false);
  }).join("");

  const postHTML = post.map((s, idx)=>{
    return rowHTML(s, false, false, true);
  }).join("");

  host.innerHTML = wrapHTML(`
    ${pre.length ? toggleRow("pre", `Itinéraire depuis ${preLabel}`) : ""}
    <div class="vFold" id="foldPre" hidden>${preHTML}</div>

    <div id="userSegment">${midHTML}</div>

    ${post.length ? toggleRow("post", `Itinéraire jusqu’à ${postLabel}`) : ""}
    <div class="vFold" id="foldPost" hidden>${postHTML}</div>
  `);

  // ✅ IMPORTANT: boutons origine/destination (uniquement sur tabs train)
  bindModalToggles();
}

function getAllModalStopRows(){
  const wrap = $("modalVWrap");
  if(!wrap) return [];
  return Array.from(wrap.querySelectorAll(".vRow"));
}

function getAllModalRowsVisible(){
  const wrap = $("modalVWrap");
  if(!wrap) return [];

  const rows = [];

  // si pre est ouvert → on inclut pre
  const pre = $("foldPre");
  if(pre && !pre.hasAttribute("hidden")){
    rows.push(...pre.querySelectorAll(".vRow"));
  }

  // segment utilisateur TOUJOURS inclus
  const user = wrap.querySelector("#userSegment");
  if(user){
    rows.push(...user.querySelectorAll(".vRow"));
  }

  // si post est ouvert → on inclut post
  const post = $("foldPost");
  if(post && !post.hasAttribute("hidden")){
    rows.push(...post.querySelectorAll(".vRow"));
  }

  return rows;
}

function layoutModalRail(){
  const wrap = $("modalVWrap");
  const rail = $("modalRail");
  if(!wrap || !rail) return;

  const rows = getAllModalRowsVisible();
  if(rows.length < 2) return;

  const wrapRect = wrap.getBoundingClientRect();
  const firstDot = rows[0].querySelector(".vDot");
  const lastDot  = rows[rows.length - 1].querySelector(".vDot");
  if(!firstDot || !lastDot) return;

  const a = firstDot.getBoundingClientRect();
  const b = lastDot.getBoundingClientRect();

  const yTop = (a.top + a.bottom)/2 - wrapRect.top;
  const yBot = (b.top + b.bottom)/2 - wrapRect.top;

  rail.style.top = `${yTop}px`;
  rail.style.height = `${Math.max(0, yBot - yTop)}px`;
}

function bindModalToggles(){
  const wrap = $("modalVWrap");
  if(!wrap) return;

  const overlay = $("modalOverlay");
  const modalEl = overlay ? overlay.querySelector(".modal") : null; // scroll container

  wrap.querySelectorAll(".vToggle").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const kind = btn.dataset.toggle; // "pre" | "post"
      const fold = (kind === "pre") ? $("foldPre") : $("foldPost");
      if(!fold) return;

      const opening = fold.hasAttribute("hidden");

      if(opening){
        fold.removeAttribute("hidden");

        // ✅ IMPORTANT: pour "post", on met le bouton APRES le fold → il finit en bas
        if(kind === "post"){
          fold.after(btn);
        }
      } else {
        fold.setAttribute("hidden","");

        // ✅ quand on referme "post", on remet le bouton AVANT le fold (sa position “fermée”)
        if(kind === "post"){
          fold.before(btn);
        }
      }

      // + => − quand ouvert
      const plus = btn.querySelector(".vTogglePlus");
      if(plus) plus.textContent = opening ? "−" : "+";

      requestAnimationFrame(()=>{
        updateUserBoundaryTimes();
        layoutModalRail();
        updateModalLive();

        // petit bonus UX: quand on ouvre "post", on scroll pour voir le bas
        if(opening && kind === "post" && modalEl){
          modalEl.scrollTo({ top: modalEl.scrollHeight, behavior: "smooth" });
        }
      });
    });
  });
}

function updateModalLive(){
  if(!modalOpen || !modalTrip) return;

  const wrap = $("modalVWrap");
  const dot  = $("modalLiveDot");
  const rail = $("modalRail");
  if(!wrap || !dot || !rail) return;

  const now = nowSeconds();

  // uniquement les rows VRAIMENT visibles (fold hidden => offsetParent null)
  const rows = getAllModalRowsVisible().filter(r => r.offsetParent !== null);
  if(rows.length < 2){
    wrap.classList.remove("is-live");
    return;
  }

  const wrapRect = wrap.getBoundingClientRect();
  const railRect = rail.getBoundingClientRect();
  const halfDot = 0; // on autorise le centre du live à atteindre railTop/railBottom

  const railTop = railRect.top - wrapRect.top;
  const railBottom = railRect.bottom - wrapRect.top;

  // stops: y = centre du rond, arr/dep en secondes
  const stops = rows.map(row=>{
    const dotEl = row.querySelector(".vDot");
    if(!dotEl) return null;

    const dr = dotEl.getBoundingClientRect();
    const y = ((dr.top + dr.bottom) / 2) - wrapRect.top;

    const arr = row.dataset.arr || "";
    const dep = row.dataset.dep || "";

    return {
      y,
      arrSec: toSeconds(arr),
      depSec: toSeconds(dep)
    };
  }).filter(Boolean);

  if(stops.length < 2){
    wrap.classList.remove("is-live");
    return;
  }

  // Fenêtre live = du PREMIER départ réel au DERNIER arrivée réelle
  const firstDep = stops.find(s => s.depSec != null);
  const lastArr = [...stops].reverse().find(s => s.arrSec != null);

  if(!firstDep || !lastArr){
    wrap.classList.remove("is-live");
    return;
  }

  const liveOk = (now >= firstDep.depSec && now <= lastArr.arrSec);
  wrap.classList.toggle("is-live", liveOk);
  if(!liveOk) return;

  // 1) pause à quai (immobile) : entre arr et dep
  for(const s of stops){
    if(s.arrSec != null && s.depSec != null){
      if(now >= s.arrSec && now < s.depSec){
        let y = s.y;
        y = clamp(y, railTop + halfDot, railBottom - halfDot);
        dot.style.top = `${y}px`;
        return;
      }
    }
  }

  // 2) en trajet : entre dep(A) et arr(B)
  for(let i=0; i<stops.length-1; i++){
    const A = stops[i];
    const B = stops[i+1];

    if(A.depSec == null || B.arrSec == null) continue;

    if(now >= A.depSec && now <= B.arrSec){
      const span = Math.max(0.001, B.arrSec - A.depSec);
      const pct = clamp((now - A.depSec) / span, 0, 1);

      let y = A.y + pct * (B.y - A.y);
      y = clamp(y, railTop + halfDot, railBottom - halfDot);
      dot.style.top = `${y}px`;
      return;
    }
  }

  // fallback clamp (rare)
  let y = stops[0].y;
  y = clamp(y, railTop + halfDot, railBottom - halfDot);
  dot.style.top = `${y}px`;
}

function computeModalGeometry(){
  const wrap = $("modalVWrap");
  if(!wrap) return null;

  // On aligne sur le segment utilisateur (mid)
  const userSeg = wrap.querySelector("#userSegment");
  if(!userSeg) return null;

  const dots = userSeg.querySelectorAll(".vDot");
  if(!dots.length) return null;

  const first = dots[0];
  const last = dots[dots.length - 1];

  const wrapRect = wrap.getBoundingClientRect();
  const a = first.getBoundingClientRect();
  const b = last.getBoundingClientRect();

  // X = centre du premier dot (réel) => live sera parfaitement aligné
  const x = (a.left + a.right) / 2 - wrapRect.left;

  // Y bornes = centres des dots first/last (réels)
  const yStart = (a.top + a.bottom) / 2 - wrapRect.top;
  const yEnd   = (b.top + b.bottom) / 2 - wrapRect.top;

  return { x, yStart, yEnd };
}

/* ============================
   LIVE animation (horizontal + modal vertical)
   ============================ */
function updateLiveDots(){
  const now = nowSeconds();

  document.querySelectorAll(".trip").forEach(card=>{
    const dep = card.dataset.depsec ? Number(card.dataset.depsec) : null;
    const arr = card.dataset.arrsec ? Number(card.dataset.arrsec) : null;

    const isLiveNow = (dep != null && arr != null && now >= dep && now <= arr);
    const isPastNow = (arr != null && now > arr);

    card.classList.toggle("is-live", isLiveNow);
    card.classList.toggle("is-past", isPastNow);

    const liveDot = card.querySelector(".rail__live");
    if(liveDot && dep != null && arr != null && arr > dep){
      let pct = ((now - dep) / (arr - dep)) * 100;
      pct = clamp(pct, 0, 100);

      // CLAMP VISUEL: avec translateX(-50%), 0% et 100% débordent forcément.
      // On clamp donc à [halfDot/railWidth, 100 - halfDot/railWidth].
      const rail = card.querySelector(".rail");
      if(rail){
        const railW = rail.getBoundingClientRect().width;
        const dotW  = liveDot.getBoundingClientRect().width || 10;
        if(railW > 0){
          const halfDotPct = (dotW / 2) / railW * 100;
          pct = clamp(pct, halfDotPct, 100 - halfDotPct);
        }
      }

      liveDot.style.left = pct + "%";
    }
  });

  updateModalLive();

  liveRAF = requestAnimationFrame(updateLiveDots);
}

function startLiveAnimation(){
  if(liveRAF != null) cancelAnimationFrame(liveRAF);
  liveRAF = requestAnimationFrame(updateLiveDots);
}

/* ============================
   SEARCH FLOW
   ============================ */
function currentQuery(){
  return {
    from: ($("from")?.value || "").trim(),
    to: ($("to")?.value || "").trim()
  };
}

function search(){
  const { from, to } = currentQuery();
  function bestStationName(raw){
    const sugg = filterStations(raw);
    if(!sugg.length) return null;

    // On valide que c’est un match "assez sûr"
    const q = compactKey(normalizeStationQuery(raw));
    const best = sugg[0];
    const b = stationsIndex.find(x => x.name === best);
    if(!b) return best;

    const d = levenshtein(q, b.compact);
    const strong = (b.key === normalizeStationQuery(raw)) || b.compact.startsWith(q) || b.compact.includes(q) || d <= 2;
    return strong ? best : null;
  }

  const fromFix = bestStationName(from);
  const toFix   = bestStationName(to);

  if(fromFix) $("from").value = fromFix;
  if(toFix)   $("to").value = toFix;
  if(!from || !to){
    renderAllRoutes();
    return;
  }

  const direct = findDirect(from, to);
  let changesRaw = findOneChange(from, to);

  const nowMin = Math.floor(nowSeconds()/60);

  // Normalise les directs pour la comparaison (format attendu par filterAndRankChanges)
  const directIts = direct.map(d => {
    const depMin = d.depFromMin;
    const arrMin = d.arrToMin;
    const durationMin = (depMin != null && arrMin != null) ? (arrMin - depMin) : null;
    return { depMin, arrMin, durationMin };
  });

  // Enrichit les correspondances (format attendu par filterAndRankChanges)
  let changes = changesRaw.map(ch => {
    const depMin = ch.leg1?.depFromMin ?? null;
    const arrMin = ch.leg2?.arrToMin ?? null;
    const durationMin = (depMin != null && arrMin != null) ? (arrMin - depMin) : null;

    const transferStation = ch.transfer; // nom de gare
    const transferClass = stationClass(transferStation);

    return {
      ...ch,
      depMin,
      arrMin,
      durationMin,
      transferStation,
      transferClass
    };
  })
  // garde seulement les classes autorisées (ex: 1 et 2)
  .filter(ch => ALLOWED_TRANSFER_CLASSES.has(ch.transferClass));

  // IMPORTANT : bons paramètres dans le bon ordre
  changes = filterAndRankChanges(changes, directIts, nowMin);

  const trips = buildTrips(direct, changes);
  renderTrips(trips, from, to);
}

function swapInputs(){
  const a = $("from");
  const b = $("to");
  if(!a || !b) return;
  [a.value, b.value] = [b.value, a.value];
  search();
}

/* ============================
   INIT
   ============================ */
(async function init(){
  const status = $("status");
  try{
    if(status) status.textContent = "Chargement des routes…";
    await loadRoutes();

    // bindSuggest($("from"), $("fromSuggest"));
    // bindSuggest($("to"), $("toSuggest"));

    $("searchBtn")?.addEventListener("click", search);
    $("swapBtn")?.addEventListener("click", swapInputs);

    $("from")?.addEventListener("focus", (e)=>openStationPicker(e.target));
    $("to")?.addEventListener("focus", (e)=>openStationPicker(e.target));

    $("from")?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") search(); });
    $("to")?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") search(); });

    $("stationCloseBtn")?.addEventListener("click", closeStationPicker);

    $("stationOverlay")?.addEventListener("mousedown", (e)=>{
      const sheet = e.currentTarget.querySelector(".stationSheet");
      if(sheet && !sheet.contains(e.target)) closeStationPicker();
    });

    $("stationSearchInput")?.addEventListener("input", (e)=>{
      renderStationList(e.target.value);
    });

    // Entrée => valide meilleur guess (ou si une seule gare filtrée)
    $("stationSearchInput")?.addEventListener("keydown", (e)=>{
      if(e.key === "Escape"){
        e.preventDefault();
        closeStationPicker();
        return;
      }
      if(e.key === "Enter"){
        e.preventDefault();

        const raw = e.target.value;
        const guess = bestStationGuess(raw);

        if(guess && stationPickerTarget){
          stationPickerTarget.value = guess;
          closeStationPicker();
          return;
        }

        // fallback: si le filtre renvoie 1 seul item visible, prendre celui-là
        const firstItem = $("stationList")?.querySelector(".stationItem");
        if(firstItem && stationPickerTarget){
          stationPickerTarget.value = firstItem.dataset.station || "";
          closeStationPicker();
        }
      }
    });

    $("mockTime")?.addEventListener("input", ()=>{
      // refresh list (home or search)
      const { from, to } = currentQuery();
      if(from && to) search();
      else renderAllRoutes();
    });

    bindModalEvents();

    // Si on arrive depuis l’accueil, on peut avoir ?from=...&to=...&time=...
    const params = new URLSearchParams(window.location.search);
    const pFrom = params.get("from") || "";
    const pTo = params.get("to") || "";
    const pTime = params.get("time") || "";

    if(pFrom) $("from").value = pFrom;
    if(pTo) $("to").value = pTo;
    if(pTime) $("mockTime").value = pTime;

    if(pFrom && pTo) search();
    else renderAllRoutes();
  } catch(err){
    console.error(err);
    if(status) status.textContent = `Erreur: ${err.message}`;
    $("results").innerHTML = "";
  }
})();
