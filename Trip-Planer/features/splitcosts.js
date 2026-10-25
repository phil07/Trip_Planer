// ─── KOSTEN AUFTEILEN ────────────────────────────────────────────────────
// Reisende verwalten, pro Ausgabe „bezahlt von" / „aufgeteilt auf" und eine
// Abrechnung mit minimalen Ausgleichszahlungen. Daten liegen in tp_budget
// (budget.travelers, entry.paidBy, entry.splitAmong) – normalisiert in app.js
// (normTravelers / normBudgetEntry). Ohne Reisende bleibt das Budget unverändert.
// Gerechnet wird ausschließlich in ganzen Cent auf Basis der EUR-Beträge (entry.amount).
(function (root) {
'use strict';

// ── Reine Logik (auch in Node testbar: tests/splitcosts.test.mjs) ──
const toCents = eur => { const n = Number(eur); return Number.isFinite(n) ? Math.round(n * 100) : 0; };

// Verteilt `cents` gleichmäßig auf `n` Personen; Restcents gehen der Reihe nach an die ersten.
function splitCents(cents, n) {
    if (!(n > 0)) return [];
    const base = Math.trunc(cents / n), rest = cents - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

// Teilnehmer einer Ausgabe in Reisenden-Reihenfolge (unbekannte IDs fallen weg; leer/fehlend = alle).
function participantsOf(entry, travelers) {
    const all = travelers.map(t => t.id);
    if (!Array.isArray(entry.splitAmong)) return all;
    const sel = new Set(entry.splitAmong);
    const ids = all.filter(id => sel.has(id));
    return ids.length ? ids : all;
}

// Saldo je Person in Cent: bezahlt − Anteil. Ausgaben ohne (bekannten) Zahler zählen nicht mit.
function computeBalances(travelers, entries) {
    const stats = new Map(travelers.map(t => [t.id, { paid: 0, share: 0, balance: 0 }]));
    let unassigned = 0;
    for (const e of entries) {
        const cents = toCents(e.amount);
        if (cents <= 0) continue;
        if (!stats.has(e.paidBy)) { unassigned++; continue; }
        const ids = participantsOf(e, travelers);
        if (!ids.length) continue;
        stats.get(e.paidBy).paid += cents;
        splitCents(cents, ids.length).forEach((c, i) => { stats.get(ids[i]).share += c; });
    }
    stats.forEach(s => { s.balance = s.paid - s.share; });
    return { stats, unassigned };
}

// Greedy: jeweils größten Schuldner mit größtem Gläubiger ausgleichen → höchstens n−1 Zahlungen.
// balances: Map oder [[id, cents], …]; Ergebnis: [{ from, to, cents }].
function settle(balances) {
    const entries = balances instanceof Map ? [...balances.entries()] : balances;
    const cred = [], debt = [];
    entries.forEach(([id, v], order) => {
        const c = Math.round(Number(v) || 0);
        if (c > 0) cred.push({ id, amt: c, order }); else if (c < 0) debt.push({ id, amt: -c, order });
    });
    const byAmt = (a, b) => b.amt - a.amt || a.order - b.order;
    const out = [];
    while (cred.length && debt.length) {
        cred.sort(byAmt); debt.sort(byAmt);
        const c = cred[0], d = debt[0], x = Math.min(c.amt, d.amt);
        out.push({ from: d.id, to: c.id, cents: x });
        c.amt -= x; d.amt -= x;
        if (!c.amt) cred.shift();
        if (!d.amt) debt.shift();
    }
    return out;
}

const api = { toCents, splitCents, participantsOf, computeBalances, settle };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof document === 'undefined') return;

// ── UI ──
const LAST_PAYER_KEY = 'tp_split_lastpayer'; // nur Komfort pro Gerät, nicht im Backup
const travelers = () => Array.isArray(budget.travelers) ? budget.travelers : [];
const nameOf = id => travelers().find(t => t.id === id)?.name || '';
const fmtC = c => fmtEuro(c / 100);
const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function lastPayer() { try { return localStorage.getItem(LAST_PAYER_KEY) || ''; } catch (e) { return ''; } }
function setLastPayer(id) { try { localStorage.setItem(LAST_PAYER_KEY, id); } catch (e) {} }
function persist() { saveBudget(); renderBudget(); }

// Abrechnungs-Karte im Budget-Kopf
function render(topCont) {
    if (!topCont) return;
    const ts = travelers();
    const card = document.createElement('div');
    card.className = 'budget-card sc-card';
    const head = `<div class="sc-head"><div class="home-card-title">Kosten aufteilen</div>
        <button type="button" class="btn-icon sc-manage" onclick="splitcosts.openTravelers()"><i class="ph-light ph-users" data-fb="👥" aria-hidden="true"></i> Reisende${ts.length ? ` (${ts.length})` : ''}</button></div>`;
    if (!ts.length) {
        card.innerHTML = head + '<div class="budget-sub">Teilt ihr euch die Kosten? Reisende anlegen und bei jeder Ausgabe festhalten, wer bezahlt hat.</div>';
        topCont.appendChild(card);
        return;
    }
    const { stats, unassigned } = computeBalances(ts, budget.entries);
    const balances = new Map(ts.map(t => [t.id, stats.get(t.id).balance]));
    const transfers = settle(balances);
    const rows = ts.map(t => {
        const s = stats.get(t.id), b = s.balance;
        const cls = b > 0 ? 'sc-pos' : b < 0 ? 'sc-neg' : '';
        const label = b > 0 ? 'bekommt' : b < 0 ? 'schuldet' : 'ausgeglichen';
        return `<div class="sc-person">
            <div class="sc-p-main"><div class="sc-p-name">${esc(t.name)}</div>
                <div class="sc-p-meta">bezahlt ${fmtC(s.paid)} · Anteil ${fmtC(s.share)}</div></div>
            <div class="sc-p-bal ${cls}">${b ? (b > 0 ? '+' : '−') + fmtC(Math.abs(b)) : '±0'}<span>${label}</span></div>
        </div>`;
    }).join('');
    const tx = transfers.length
        ? transfers.map(x => `<li class="sc-tx"><i class="ph-light ph-arrow-right" data-fb="→" aria-hidden="true"></i><span><b>${esc(nameOf(x.from))}</b> zahlt <b>${esc(nameOf(x.to))}</b> ${fmtC(x.cents)}</span></li>`).join('')
        : '<li class="sc-tx sc-tx-done">✅ Alles ausgeglichen</li>';
    card.innerHTML = head + `<div class="sc-people">${rows}</div>
        <div class="sc-sub-title">Ausgleichszahlungen</div><ul class="sc-txs">${tx}</ul>
        ${unassigned ? `<div class="budget-sub">${unassigned} Ausgabe${unassigned === 1 ? '' : 'n'} ohne Zahler – nicht in der Abrechnung. Tippe in der Liste auf „Zahler zuordnen".</div>` : ''}`;
    topCont.appendChild(card);
}

// Zusatzzeile in der Ausgabenliste („👤 Anna · für alle")
function entryMeta(e) {
    const ts = travelers();
    if (!ts.length) return '';
    const payer = nameOf(e.paidBy);
    const ids = participantsOf(e, ts);
    const forWho = ids.length === ts.length ? 'für alle' : 'für ' + ids.map(nameOf).join(', ');
    return `<button type="button" class="sc-entry-chip${payer ? '' : ' sc-missing'}" data-id="${esc(e.id)}" onclick="splitcosts.editEntry(this.dataset.id)" aria-label="Aufteilung bearbeiten">`
        + (payer ? `👤 ${esc(payer)} · ${esc(forWho)}` : '👤 Zahler zuordnen') + '</button>';
}

// Formular „bezahlt von" + „aufgeteilt auf" in einen Container rendern
function fillForm(cont, entry) {
    if (!cont) return;
    const ts = travelers();
    cont.hidden = !ts.length;
    if (!ts.length) { cont.innerHTML = ''; return; }
    const payer = entry && ts.some(t => t.id === entry.paidBy) ? entry.paidBy
        : ts.some(t => t.id === lastPayer()) ? lastPayer() : ts[0].id;
    const sel = new Set(entry ? participantsOf(entry, ts) : ts.map(t => t.id));
    const uid = cont.id || 'sc';
    cont.innerHTML = `<div class="form-group"><label for="${esc(uid)}-payer">Bezahlt von</label>
            <select id="${esc(uid)}-payer" class="sc-payer">${ts.map(t => `<option value="${esc(t.id)}"${t.id === payer ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
        <div class="form-group"><span class="sc-label" id="${esc(uid)}-split-lbl">Aufgeteilt auf (gleichmäßig)</span>
            <div class="chip-group sc-split" role="group" aria-labelledby="${esc(uid)}-split-lbl">${ts.map(t => {
                const on = sel.has(t.id);
                return `<button type="button" class="chip chip-sm${on ? ' active' : ''}" aria-pressed="${on}" data-tid="${esc(t.id)}">${esc(t.name)}</button>`;
            }).join('')}</div></div>`;
    cont.querySelectorAll('.sc-split .chip').forEach(c => c.onclick = () => {
        const on = !c.classList.contains('active');
        c.classList.toggle('active', on); c.setAttribute('aria-pressed', String(on)); haptic();
    });
}
// Liest das Formular; {} ohne Reisende, null bei ungültiger Auswahl (mit Hinweis).
function readForm(cont) {
    const ts = travelers();
    if (!cont || !ts.length || cont.hidden) return {};
    const paidBy = cont.querySelector('.sc-payer')?.value;
    if (!ts.some(t => t.id === paidBy)) { showToast('⚠️ Bitte auswählen, wer bezahlt hat'); return null; }
    const known = new Set(ts.map(t => t.id));
    const splitAmong = [...cont.querySelectorAll('.sc-split .chip.active')].map(c => c.dataset.tid).filter(id => known.has(id));
    if (!splitAmong.length) { showToast('⚠️ Bitte mindestens eine Person zum Aufteilen wählen'); return null; }
    setLastPayer(paidBy);
    return { paidBy, splitAmong };
}

// ── Dialoge (einmalig angelegt) ──
function makeDialog(id, title, bodyHtml, actionsHtml) {
    const d = document.createElement('dialog');
    d.id = id; d.setAttribute('aria-labelledby', id + '-title');
    d.innerHTML = `<h3 id="${id}-title">${title}</h3><div class="dialog-body">${bodyHtml}</div><div class="dialog-actions">${actionsHtml}</div>`;
    (document.querySelector('.app-container') || document.body).appendChild(d);
    return d;
}
const editDlg = makeDialog('modal-splitcosts-entry', 'Ausgabe aufteilen',
    '<div class="sc-edit-desc budget-sub" id="sc-edit-desc"></div><div id="sc-edit-form"></div>',
    '<button class="btn" onclick="splitcosts.saveEdit()">Speichern</button><button class="btn btn-secondary" onclick="this.closest(\'dialog\').close()">Abbrechen</button>');
const travDlg = makeDialog('modal-splitcosts-travelers', 'Reisende',
    `<div class="budget-sub sc-trav-hint">Wer reist mit? Danach kannst du bei jeder Ausgabe angeben, wer bezahlt hat und auf wen sie aufgeteilt wird.</div>
     <div id="sc-trav-list"></div>
     <div class="form-group"><label for="sc-trav-new">Person hinzufügen</label>
        <div class="input-row"><input type="text" id="sc-trav-new" maxlength="40" placeholder="Name" class="input-grow" enterkeyhint="done">
        <button type="button" class="btn-icon" onclick="splitcosts.addTraveler()"><i class="ph-light ph-plus" data-fb="+" aria-hidden="true"></i> Hinzufügen</button></div></div>`,
    '<button class="btn btn-secondary" onclick="this.closest(\'dialog\').close()">Fertig</button>');
travDlg.querySelector('#sc-trav-new').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTraveler(); } });

let editId = null;
function editEntry(id) {
    const e = budget.entries.find(x => x.id === id);
    if (!e || !travelers().length) return;
    editId = id;
    document.getElementById('sc-edit-desc').textContent = `${e.desc || e.cat} · ${fmtEuro(e.amount)}`;
    fillForm(document.getElementById('sc-edit-form'), e);
    editDlg.showModal();
}
function saveEdit() {
    const e = budget.entries.find(x => x.id === editId);
    if (!e) { editDlg.close(); return; }
    const split = readForm(document.getElementById('sc-edit-form'));
    if (!split) return;
    Object.assign(e, split);
    persist(); editDlg.close();
    showToast('✅ Aufteilung gespeichert');
}

function renderTravelerList() {
    const ts = travelers();
    document.getElementById('sc-trav-list').innerHTML = ts.length ? ts.map(t => `
        <div class="sc-trav-row">
            <input type="text" value="${esc(t.name)}" maxlength="40" data-tid="${esc(t.id)}" aria-label="Name von ${esc(t.name)}" onchange="splitcosts.renameTraveler(this.dataset.tid, this)">
            <button type="button" class="del-btn" data-tid="${esc(t.id)}" onclick="splitcosts.removeTraveler(this.dataset.tid)" aria-label="${esc(t.name)} entfernen">✕</button>
        </div>`).join('') : '<div class="budget-sub">Noch keine Reisenden.</div>';
}
function openTravelers() {
    renderTravelerList();
    document.getElementById('sc-trav-new').value = '';
    travDlg.showModal();
}
function addTraveler() {
    const inp = document.getElementById('sc-trav-new');
    const name = inp.value.trim().slice(0, 40);
    if (!name) { showToast('⚠️ Bitte einen Namen eingeben'); return; }
    if (travelers().length >= 50) { showToast('⚠️ Maximal 50 Reisende'); return; }
    if (travelers().some(t => t.name.toLowerCase() === name.toLowerCase())) { showToast(`⚠️ „${name}" gibt es schon`); return; }
    budget.travelers = [...travelers(), { id: newId(), name }];
    inp.value = '';
    persist(); renderTravelerList(); haptic();
}
function renameTraveler(id, input) {
    const t = travelers().find(x => x.id === id);
    if (!t) return;
    const name = input.value.trim().slice(0, 40);
    if (!name || travelers().some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
        showToast(name ? `⚠️ „${name}" gibt es schon` : '⚠️ Name darf nicht leer sein');
        input.value = t.name; return;
    }
    t.name = name;
    persist(); renderTravelerList();
}
function removeTraveler(id) {
    const t = travelers().find(x => x.id === id);
    if (!t) return;
    const refs = budget.entries.filter(e => e.paidBy === id || (Array.isArray(e.splitAmong) && e.splitAmong.includes(id))).length;
    if (refs && !confirm(`${t.name} kommt in ${refs} Ausgabe${refs === 1 ? '' : 'n'} vor. Trotzdem entfernen? Von ${t.name} bezahlte Ausgaben verlieren ihren Zahler.`)) return;
    // Stand für „Rückgängig" sichern
    const snapTravelers = travelers().map(x => ({ ...x }));
    const snapSplits = new Map(budget.entries.map(e => [e.id, { paidBy: e.paidBy, splitAmong: e.splitAmong }]));
    const rest = travelers().filter(x => x.id !== id);
    budget.entries.forEach(e => {
        if (e.paidBy === id || !rest.length) delete e.paidBy;
        if (Array.isArray(e.splitAmong)) {
            const s = e.splitAmong.filter(x => x !== id);
            if (s.length && rest.length) e.splitAmong = s; else delete e.splitAmong;
        }
    });
    if (rest.length) budget.travelers = rest; else delete budget.travelers; // ohne Reisende: Budget wie bisher
    haptic(); persist(); renderTravelerList();
    showUndoToast(`🗑️ ${t.name} entfernt`, () => {
        if (travelers().some(x => x.id === id)) return;
        budget.travelers = snapTravelers;
        budget.entries.forEach(e => {
            const s = snapSplits.get(e.id);
            if (!s) return;
            if (s.paidBy) e.paidBy = s.paidBy; else delete e.paidBy;
            if (s.splitAmong) e.splitAmong = s.splitAmong; else delete e.splitAmong;
        });
        persist();
        if (travDlg.open) renderTravelerList();
    });
}

root.splitcosts = { ...api, render, entryMeta, fillModal: c => fillForm(c, null), readModal: readForm,
    editEntry, saveEdit, openTravelers, addTraveler, renameTraveler, removeTraveler };
})(typeof window !== 'undefined' ? window : globalThis);
