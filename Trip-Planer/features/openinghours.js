// ─── ÖFFNUNGSZEITEN & RUHETAGE ────────────────────────────────────────────
// Aktivitäten haben optional `hours` ({ closed: [0–6], from: 'HH:MM', to: 'HH:MM', src })
// und eine geplante Uhrzeit `time` (HH:MM) – beides wird in app.js (normAct/normHours)
// streng normalisiert. Diese Datei liefert:
//   • fromOsm(str)   – OSM-opening_hours-Tag (kommt kostenlos mit der Geoapify-Antwort)
//                      vorsichtig in unser einfaches Modell übersetzen, sonst null
//   • fillDialog(a) / readDialog() – Felder im Aktivitäts-Dialog
//   • warnHtml(a)    – Warnhinweis für den Tagesplan (Ruhetag / außerhalb der Öffnungszeit)
// Bewusst KEINE Google-Abfrage: das Feld regularOpeningHours fällt bei der neuen Places-API
// in eine teurere Abrechnungsstufe – Google-Daten werden daher nicht vorbelegt.
(function () {
    'use strict';
    // Anzeige-Reihenfolge Mo → So, Werte wie Date.getDay() (0 = Sonntag).
    const DAYS = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']];
    const DAY_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
    const OSM_DAY = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
    const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
    const pad = n => String(n).padStart(2, '0');

    // ── OSM-Parser ──
    // Unterstützt die üblichen Formen ("Tu-Su 09:30-17:00; Mo off", "Mo-Fr 10:00-18:00;
    // Sa,Su 10:00-17:00", "09:00-17:00", "10:00-14:00,17:00-22:00"). Alles Kompliziertere
    // (Monate, Feiertage-only, Wochen-Nummern, Kommentare …) → null, damit nie falsche
    // Ruhetage vorbelegt werden. Mehrere Zeitfenster werden zu frühestem Beginn / spätestem
    // Ende zusammengefasst (Mittagspause geht dabei verloren).
    function parseDaySel(sel) {
        const out = new Set();
        for (const part of sel.split(',')) {
            const m = part.trim().match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
            if (!m) return null;
            const a = OSM_DAY[m[1]], b = m[2] ? OSM_DAY[m[2]] : a;
            // Bereiche wie "Fr-Mo" laufen über das Wochenende (Mo=1 … Su=0 → zyklisch).
            for (let d = a, i = 0; i < 8; d = (d + 1) % 7, i++) { out.add(d); if (d === b) break; }
        }
        return out;
    }
    function fromOsm(str) {
        if (typeof str !== 'string') return null;
        str = str.trim();
        if (!str || str.length > 500 || str === '24/7') return null;
        const open = new Set(), off = new Set();
        let from = null, to = null, overnight = false;
        // PH/SH-Regeln (Feiertage/Schulferien) betreffen keine Wochentage → überspringen.
        const rules = str.split(';').map(r => r.trim()).filter(Boolean).filter(r => !/^(PH|SH)\b/.test(r));
        if (!rules.length) return null;
        for (const rule of rules) {
            const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?(?:\s*,\s*PH)?\s*(.*)$/);
            if (!m) return null;
            const days = m[1] ? parseDaySel(m[1].replace(/\s+/g, '')) : new Set([0, 1, 2, 3, 4, 5, 6]);
            if (!days) return null;
            const rest = m[2].trim();
            if (/^(off|closed)$/i.test(rest)) { days.forEach(d => { off.add(d); open.delete(d); }); continue; }
            if (!rest) return null; // "Mo-Fr" ohne Zeit ist mehrdeutig
            const ranges = rest.split(',').map(x => x.trim());
            for (const r of ranges) {
                const t = r.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\+?$/);
                if (!t) return null;
                const h1 = +t[1], m1 = +t[2], h2 = +t[3], m2 = +t[4];
                if (h1 > 24 || h2 > 48 || m1 > 59 || m2 > 59) return null;
                const s = h1 * 60 + m1;
                // Ende ≥ 24:00 bzw. Ende vor Beginn = über Mitternacht; "24:00" → 23:59.
                let e = h2 * 60 + m2, ov = false;
                if (e > 24 * 60) { e -= 24 * 60; ov = true; } else if (e === 24 * 60) e = 24 * 60 - 1;
                else if (e < s) ov = true;
                if (from === null || s < from) from = s;
                // Über Mitternacht: Endzeit am Folgetag gewinnt immer.
                if (ov) { overnight = true; to = e; } else if (!overnight && (to === null || e > to)) to = e;
            }
            days.forEach(d => { open.add(d); off.delete(d); });
        }
        if (!open.size) return null;
        const closed = [0, 1, 2, 3, 4, 5, 6].filter(d => !open.has(d));
        const fmt = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
        return normHours({ closed, from: from === null ? '' : fmt(from), to: to === null ? '' : fmt(to), src: 'OpenStreetMap' });
    }

    // ── Prüfung ──
    function inWindow(time, h) {
        const t = toMin(time), f = toMin(h.from), e = toMin(h.to);
        return f < e ? t >= f && t <= e : t >= f || t <= e; // e < f: über Mitternacht
    }
    const isMuseum = a => /museum|museo|musée|galerie|gallery|美術館|博物館|資料館/i.test(`${a.type} ${a.title}`);
    // Liefert eine Liste von { level: 'warn'|'info', text } für eine eingeplante Aktivität.
    function issues(a) {
        if (!a || !a.day || !/^\d{4}-\d{2}-\d{2}$/.test(a.day)) return [];
        const wd = parseISODate(a.day).getDay();
        if (!Number.isInteger(wd)) return [];
        const h = a.hours, out = [];
        if (h) {
            if (h.closed.includes(wd)) out.push({ level: 'warn', text: `Ruhetag am ${DAY_LONG[wd]}` });
            else if (a.time && h.from && h.to && !inWindow(a.time, h))
                out.push({ level: 'warn', text: `Außerhalb der Öffnungszeit (${h.from}–${h.to} Uhr)` });
        } else if (wd === 1 && isMuseum(a) && (!tripCountry || tripCountry === 'Japan')) {
            out.push({ level: 'info', text: 'Viele Museen in Japan haben montags Ruhetag – Öffnungszeiten prüfen' });
        }
        return out;
    }
    function warnHtml(a) {
        const list = issues(a);
        const timeChip = a && a.day && a.time ? `<span class="oh-time"><i class="ph ph-clock" aria-hidden="true"></i> ${esc(a.time)}</span>` : '';
        if (!list.length) return timeChip ? `<div class="oh-line">${timeChip}</div>` : '';
        return `<div class="oh-line">${timeChip}${list.map(x => `
            <button type="button" class="oh-warn oh-lvl-${x.level}" data-id="${esc(String(a.id))}" onclick="openEditActivity(+this.dataset.id)" aria-label="${esc(x.text)} – Aktivität bearbeiten">
                <i class="ph ${x.level === 'warn' ? 'ph-warning' : 'ph-info'}" aria-hidden="true"></i><span>${esc(x.text)}</span>
            </button>`).join('')}</div>`;
    }

    // ── Dialog ──
    function boxHtml() {
        return `
            <div class="form-group oh-group">
                <label for="a-time">Geplante Uhrzeit (optional)</label>
                <input type="time" id="a-time" class="oh-time-input" step="300">
            </div>
            <fieldset class="form-group oh-group">
                <legend>Öffnungszeiten (optional)</legend>
                <div class="oh-sub">Ruhetage</div>
                <div class="oh-days" role="group" aria-label="Ruhetage">
                    ${DAYS.map(([d, l]) => `<label class="oh-day"><input type="checkbox" value="${d}" data-oh-day><span>${l}</span></label>`).join('')}
                </div>
                <div class="oh-sub">Geöffnet</div>
                <div class="oh-range">
                    <input type="time" id="a-open-from" aria-label="Geöffnet von">
                    <span aria-hidden="true">–</span>
                    <input type="time" id="a-open-to" aria-label="Geöffnet bis">
                    <button type="button" class="link-btn" id="a-hours-clear">Leeren</button>
                </div>
                <p class="form-hint" id="a-hours-src"></p>
            </fieldset>`;
    }
    let dlgSrc = 'manual', dlgInitial = '';
    const box = () => document.getElementById('a-hours-box');
    const snapshot = () => JSON.stringify(rawDialog());
    function rawDialog() {
        const b = box();
        return {
            closed: [...b.querySelectorAll('[data-oh-day]:checked')].map(x => +x.value),
            from: b.querySelector('#a-open-from').value, to: b.querySelector('#a-open-to').value
        };
    }
    function fillDialog(a) {
        const b = box();
        if (!b) return;
        if (!b.firstChild) {
            b.innerHTML = boxHtml();
            b.querySelector('#a-hours-clear').addEventListener('click', () => {
                b.querySelectorAll('[data-oh-day]').forEach(x => { x.checked = false; });
                b.querySelector('#a-open-from').value = ''; b.querySelector('#a-open-to').value = '';
                updateHint();
            });
            b.addEventListener('input', updateHint);
        }
        const h = a && a.hours;
        b.querySelectorAll('[data-oh-day]').forEach(x => { x.checked = !!h && h.closed.includes(+x.value); });
        b.querySelector('#a-open-from').value = h ? h.from : '';
        b.querySelector('#a-open-to').value = h ? h.to : '';
        b.querySelector('#a-time').value = a && a.time ? a.time : '';
        dlgSrc = h ? h.src : 'manual';
        dlgInitial = snapshot();
        updateHint();
    }
    function updateHint() {
        const b = box(), hint = b && b.querySelector('#a-hours-src');
        if (!hint) return;
        const r = rawDialog();
        const partial = !!r.from !== !!r.to || (r.from && r.from === r.to);
        if (partial) hint.textContent = 'Bitte „von“ und „bis“ angeben (unterschiedliche Zeiten).';
        else if (r.closed.length === 7) hint.textContent = 'Nicht alle Tage können Ruhetag sein.';
        else if (dlgSrc === 'OpenStreetMap' && snapshot() === dlgInitial) hint.textContent = 'Automatisch aus OpenStreetMap übernommen – bitte vor Ort prüfen.';
        else hint.textContent = 'Wird im Tagesplan geprüft (Ruhetag / Uhrzeit außerhalb der Öffnungszeit).';
        hint.classList.toggle('oh-hint-err', !!partial || r.closed.length === 7);
    }
    function readDialog() {
        const b = box();
        if (!b || !b.firstChild) return null;
        const r = rawDialog();
        // Unverändert aus OSM übernommene Werte behalten ihre Quelle, alles andere ist manuell.
        const src = dlgSrc === 'OpenStreetMap' && snapshot() === dlgInitial ? 'OpenStreetMap' : 'manual';
        const t = b.querySelector('#a-time').value;
        return { hours: normHours({ ...r, src }), time: isHHMM(t) ? t : '' };
    }

    window.openingHours = { fromOsm, issues, warnHtml, fillDialog, readDialog };
})();
