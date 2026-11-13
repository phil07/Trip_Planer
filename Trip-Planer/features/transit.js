// ─── ZUGVERBINDUNGEN ZWISCHEN STATIONEN ─────────────────────────────────
// „Weiter nach …“ in der Stationsliste und im Tagesplan am Tag des Stationswechsels:
// Luftlinie, grob geschätzte Fahrzeit (Heuristik, klar als „ca.“ markiert), Links zu
// Google Maps (ÖPNV) und zu den japanischen Fahrplanauskünften sowie optional die
// tatsächlich gebuchte Verbindung. Die liegt – wie das Transportmittel – im
// transit-Feld der ZIELstation (normTransit in app.js normalisiert sie beim Laden).
(() => {
    // Ungefähre Lage der Shinkansen-Bahnhöfe (Tokaido/Sanyo/Kyushu/Tohoku/Joetsu/Hokuriku/Hokkaido).
    const SHINKANSEN = [
        [35.681, 139.767], [35.628, 139.739], [35.507, 139.617], [35.906, 139.624], [35.256, 139.155], [35.104, 139.078],
        [35.126, 138.911], [34.972, 138.389], [34.704, 137.735], [34.763, 137.382], [35.171, 136.882], [35.316, 136.686],
        [35.315, 136.290], [34.986, 135.759], [34.733, 135.500], [34.706, 135.196], [34.827, 134.691], [34.666, 133.918],
        [34.489, 133.362], [34.398, 132.475], [34.094, 131.396], [33.886, 130.882], [33.590, 130.421], [32.790, 130.689],
        [31.584, 130.541], [32.752, 129.870], [36.559, 139.898], [37.398, 140.388], [37.754, 140.459], [38.260, 140.882],
        [38.248, 140.328], [39.701, 141.136], [39.717, 140.129], [40.827, 140.694], [41.905, 140.649], [36.322, 139.013],
        [37.912, 139.062], [36.343, 138.635], [36.643, 138.189], [36.701, 137.213], [36.578, 136.648], [36.062, 136.223],
        [35.645, 136.075]
    ];
    const SERVED_KM = 25; // so nah am Shinkansen-Bahnhof gilt ein Ort als „angebunden“
    const openLegs = new Set(); // aufgeklappte Etappen überstehen das Neu-Rendern der Liste

    const hasGeo = (lat, lng) => typeof lat === 'number' && typeof lng === 'number' && (lat !== 0 || lng !== 0);
    // Hotel → Hotel, wenn Koordinaten da sind, sonst Stationsmittelpunkt; ohne Koordinaten nur der Name.
    function endpoint(p) {
        if (hasGeo(p.hotelLat, p.hotelLng)) return { lat: p.hotelLat, lng: p.hotelLng, hotel: true };
        if (hasGeo(p.lat, p.lng)) return { lat: p.lat, lng: p.lng, hotel: false };
        return null;
    }
    function nearestShinkansen(pt) {
        let best = null, bestD = Infinity;
        SHINKANSEN.forEach(([lat, lng]) => {
            const d = distanceKm(pt.lat, pt.lng, lat, lng);
            if (d < bestD) { bestD = d; best = { lat, lng }; }
        });
        return { st: best, d: bestD };
    }
    const shinMin = km => km * 1.25 / 220 * 60 + 20;
    const regMin = km => km * 1.25 / 70 * 60;
    const isJapan = pt => pt.lat > 24 && pt.lat < 46 && pt.lng > 122 && pt.lng < 146;

    // Heuristik: beide Enden nahe am Netz → Shinkansen; ein Ende abseits → Zubringer per
    // Regionalzug + Shinkansen dazwischen (wenn das kürzer wirkt als komplett Regionalzug).
    function estimate(a, b, km) {
        if (km < 40) return { min: regMin(km), mode: 'Zug' };
        const na = nearestShinkansen(a), nb = nearestShinkansen(b);
        const accA = na.d > SERVED_KM ? na.d : 0, accB = nb.d > SERVED_KM ? nb.d : 0;
        const mid = distanceKm(na.st.lat, na.st.lng, nb.st.lat, nb.st.lng);
        if (!accA && !accB && mid >= 40) return { min: shinMin(km), mode: 'Zug' };
        if (mid >= 80) {
            const mixed = regMin(accA) + regMin(accB) + shinMin(mid);
            if (mixed < regMin(km)) return { min: mixed, mode: 'Zug' };
        }
        return { min: regMin(km), mode: 'Zug' };
    }
    // Strecke und Dauer je Verkehrsmittel. f = Faktor Luftlinie → tatsächliche Strecke, kmh = Reisetempo
    // unterwegs, fix = feste Zeit in Minuten (Flughafen, Einsteigen …). Alles grobe Richtwerte.
    const MODES = {
        'Flug':      { f: 1.0,  kmh: 750, fix: 180, note: 'inkl. ca. 3 Std. für Anreise zum Flughafen, Check-in und Boarding', gm: 'transit' },
        'Zug':       { f: 1.25, kmh: 90,  fix: 10,  gm: 'transit' },
        'Bus':       { f: 1.3,  kmh: 60,  fix: 15,  gm: 'transit' },
        'Mietwagen': { f: 1.3,  kmh: 75,  fix: 10,  gm: 'driving' },
        'Fähre':     { f: 1.15, kmh: 30,  fix: 45,  gm: 'transit' },
        'Zu Fuß':    { f: 1.25, kmh: 5,   fix: 0,   gm: 'walking' }
    };
    // Wird für eine Etappe ein Transportmittel gewählt, bestimmt es Strecke und Dauer; ohne Auswahl
    // gilt wie bisher die Bahn-Heuristik.
    function estimateFor(label, a, b, km) {
        const m = MODES[label];
        if (!m) return null;
        let min, dist = km * m.f, mode = label;
        if (label === 'Zug' && isJapan(a) && isJapan(b)) {
            min = estimate(a, b, km).min; // Japan: Schnellzug-Netz berücksichtigt, im Text trotzdem einfach „Zug“
        } else if (label === 'Flug') {
            // Sehr kurze Strecken: Flughafen-Aufwand bleibt, die Flugzeit ist aber mindestens 30 Min.
            min = Math.max(30, km / m.kmh * 60 + 15) + m.fix;
        } else {
            min = dist / m.kmh * 60 + m.fix;
        }
        return { min, mode, dist, note: m.note || '', gm: m.gm };
    }
    function fmtDuration(min) {
        const m = Math.max(5, Math.round(min / 5) * 5), h = Math.floor(m / 60), r = m % 60;
        return h ? `${h} Std.${r ? ` ${r} Min.` : ''}` : `${r} Min.`;
    }
    const fmtKm = km => `${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} km`;

    // Alles Nötige zur Etappe Station i → Station i+1.
    function legInfo(i) {
        const from = places[i], to = places[i + 1];
        if (!from || !to) return null;
        const a = endpoint(from), b = endpoint(to);
        const fromName = clean(from.name), toName = clean(to.name);
        const info = { from, to, fromName, toName, a, b, day: computedData[i]?.isoEnd || '', km: null, est: null };
        if (a && b) {
            info.km = distanceKm(a.lat, a.lng, b.lat, b.lng);
            const label = transportMode(to.transport).label;
            info.est = estimateFor(label, a, b, info.km) ||
                (isJapan(a) && isJapan(b) ? estimate(a, b, info.km) : estimateFor('Zug', a, b, info.km));
            info.est.dist = info.est.dist ?? info.km * 1.25;
            info.est.gm = info.est.gm || 'transit';
        }
        const where = (pt, p, name) => pt ? `${pt.lat},${pt.lng}` : [p.hotel, name].filter(Boolean).join(', ');
        info.gmaps = 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(where(a, from, fromName)) +
            '&destination=' + encodeURIComponent(where(b, to, toName)) + '&travelmode=' + (info.est ? info.est.gm : 'transit');
        info.japan = (a && b) ? isJapan(a) && isJapan(b) : (typeof tripCountry !== 'string' || !tripCountry || /japan/i.test(tripCountry));
        return info;
    }

    // Symbol der Etappe passend zum gewählten Verkehrsmittel (ohne Auswahl: Zug wie bisher)
    function legIcon(info) {
        const m = transportMode(info.to.transport);
        return m.label ? ico(m.icon, m.fb) : ico('train-simple', '🚆');
    }
    const onRails = info => ['', 'Zug', 'Bus'].includes(transportMode(info.to.transport).label);
    function summaryText(info) {
        return info.km == null ? 'Distanz unbekannt (keine Koordinaten)'
            : `${info.est.mode} · ca. ${fmtKm(info.est.dist)} · ca. ${fmtDuration(info.est.min)}`;
    }
    function connectionHtml(t) {
        if (!t) return '';
        const parts = [t.train, t.dep ? `ab ${t.dep} Uhr` : '', t.seat].filter(Boolean);
        return `<div class="transit-conn">
                <div class="transit-conn-main">${ico('ticket', '🎫')}<span>${esc(parts.join(' · ') || 'Verbindung')}</span></div>
                ${t.note ? `<div class="transit-conn-note">${esc(t.note)}</div>` : ''}
            </div>`;
    }
    // Gemeinsamer Inhalt für Stationsliste und Tagesplan.
    function bodyHtml(info, idx) {
        const basis = info.km == null ? 'Ohne Koordinaten – Google Maps sucht nach den Namen.'
            : `${info.a.hotel ? 'Hotel' : 'Stationsmitte'} → ${info.b.hotel ? 'Hotel' : 'Stationsmitte'} · Luftlinie ${esc(fmtKm(info.km))} · geschätzt per ${esc(info.est.mode)}${info.est.note ? ` (${esc(info.est.note)})` : ''}${info.km > 900 && info.est.mode !== 'Flug' ? ' · Flug ist ggf. schneller' : ''}. Nur ein grober Richtwert.`;
        const t = info.to.transit;
        return `
            <div class="transit-facts">
                <span class="transit-fact">${ico('ruler', '📏')} ${info.km == null ? '–' : `ca. ${esc(fmtKm(info.est.dist))}`}</span>
                <span class="transit-fact">${ico('clock', '⏱')} ${info.km == null ? '–' : `ca. ${esc(fmtDuration(info.est.min))}`}</span>
            </div>
            <p class="transit-basis">${basis}</p>
            ${connectionHtml(t)}
            <div class="transit-actions">
                <a class="transit-link" href="${esc(info.gmaps)}" target="_blank" rel="noopener">${ico('map-trifold', '🗺')}<span>${info.est && info.est.gm === 'driving' ? 'Route in Google Maps (Auto)' : info.est && info.est.gm === 'walking' ? 'Route in Google Maps (zu Fuß)' : 'Verbindung in Google Maps (ÖPNV)'}</span></a>
                ${info.japan && onRails(info) ? `<a class="transit-link" href="https://world.jorudan.co.jp/mln/en/" target="_blank" rel="noopener">${ico('train', '🚄')}<span>Japan Transit Planner (Jorudan)</span></a>
                <a class="transit-link" href="https://japantravel.navitime.com/en/" target="_blank" rel="noopener">${ico('compass', '🧭')}<span>NAVITIME Japan Travel</span></a>` : ''}
                <button type="button" class="transit-link transit-edit" data-i="${idx}">${ico(t ? 'pencil-simple' : 'plus', t ? '✏️' : '+')}<span>${t ? 'Verbindung bearbeiten' : 'Gebuchte Verbindung eintragen'}</span></button>
            </div>`;
    }
    function wire(root) {
        root.querySelectorAll('.transit-edit').forEach(b => b.addEventListener('click', () => openEditor(+b.dataset.i)));
    }

    // Stationsliste: aufklappbarer Abschnitt unter dem Transport-Knopf der Etappe.
    function legEl(i) {
        const info = legInfo(i);
        const el = document.createElement('details');
        el.className = 'transit-leg';
        if (!info) return el;
        const key = String(info.to.id);
        el.open = openLegs.has(key);
        el.addEventListener('toggle', () => { el.open ? openLegs.add(key) : openLegs.delete(key); });
        el.innerHTML = `
            <summary>${legIcon(info)}<span class="transit-sum-text"><b>Weiter nach ${esc(info.toName)}</b><small>${esc(summaryText(info))}</small></span>${ico('caret-down')}</summary>
            <div class="transit-body">${bodyHtml(info, i)}</div>`;
        wire(el);
        return el;
    }

    // Tagesplan: Block in die Karte des Wechseltags einfügen bzw. eigene Tageskarte anlegen.
    function renderDayPlan(list) {
        list.querySelectorAll('.transit-day, .transit-day-card, .transit-day-section').forEach(n => n.remove());
        const legs = [];
        for (let i = 0; i < places.length - 1; i++) { const info = legInfo(i); if (info && info.day) legs.push({ info, i }); }
        if (!legs.length) return;
        const dayCards = () => [...list.querySelectorAll('.dayplan-card[data-day]')];
        legs.forEach(({ info, i }) => {
            const block = document.createElement('div');
            block.className = 'transit-day';
            block.innerHTML = `<div class="transit-day-title">${legIcon(info)}<span>Weiter nach ${esc(info.toName)}${info.to.transit?.dep ? ` · ${esc(info.to.transit.dep)} Uhr` : ''}</span></div>${bodyHtml(info, i)}`;
            wire(block);
            const same = dayCards().find(c => c.dataset.day === info.day);
            if (same) { same.querySelector('.dayplan-header')?.after(block); return; }
            const card = document.createElement('div');
            card.className = 'dayplan-card transit-day-card';
            card.dataset.day = info.day;
            card.innerHTML = `<div class="dayplan-header"><h3>${esc(fmtDayLong(info.day))}</h3><span class="dayplan-count">Stationswechsel</span></div>`;
            card.appendChild(block);
            const cards = dayCards(), later = cards.find(c => c.dataset.day > info.day);
            if (later) later.before(card);
            else if (cards.length) cards[cards.length - 1].after(card);
            else {
                // Noch keine Tageskarten: eigener Abschnitt ganz oben (bzw. nach dem Leer-Hinweis).
                let sec = list.querySelector('.transit-day-section');
                if (!sec) {
                    sec = document.createElement('div'); sec.className = 'dayplan-section transit-day-section';
                    sec.textContent = 'Stationswechsel';
                    const empty = list.querySelector('.empty-acts');
                    empty ? empty.after(sec) : list.prepend(sec);
                }
                sec.after(card);
            }
        });
    }

    // ─── Editor für die gebuchte Verbindung ──────────────────────────────
    let editIdx = -1;
    let editKind = 'leg'; // 'leg' (Etappe nach places[idx+1]) | 'arrival' (Anreise nach places[0]) | 'return' (Rückreise)
    function bookingOf(kind, idx) {
        if (kind === 'arrival') return places[0]?.transit || null;
        if (kind === 'return') return window.tripBooking?.return || null;
        return places[idx + 1]?.transit || null;
    }
    function setBooking(kind, idx, value) {
        if (kind === 'arrival') places[0].transit = value;
        else if (kind === 'return') window.tripBooking.return = value;
        else places[idx + 1].transit = value;
    }
    function dialog() {
        let d = document.getElementById('modal-transit');
        if (d) return d;
        d = document.createElement('dialog');
        d.id = 'modal-transit';
        d.setAttribute('aria-labelledby', 'modal-transit-title');
        d.innerHTML = `
            <h3 id="modal-transit-title">Zugverbindung</h3>
            <div class="dialog-body">
                <p class="tr-route" id="transit-route"></p>
                <div class="form-group"><label for="transit-train">Zug</label><input type="text" id="transit-train" maxlength="60" placeholder="z. B. Nozomi 215"></div>
                <div class="form-group"><label for="transit-dep">Abfahrt</label><input type="time" id="transit-dep"></div>
                <div class="form-group"><label for="transit-seat">Gleis / Sitz</label><input type="text" id="transit-seat" maxlength="40" placeholder="z. B. Gleis 14 · Wagen 7, 12A"></div>
                <div class="form-group"><label for="transit-note">Notiz</label><textarea id="transit-note" maxlength="200" placeholder="z. B. JR Pass, Sitz reserviert, Umstieg in Nagoya"></textarea></div>
            </div>
            <div class="dialog-actions">
                <button type="button" class="btn" id="transit-save">Speichern</button>
                <button type="button" class="btn btn-secondary" id="transit-del">Verbindung entfernen</button>
                <button type="button" class="btn btn-secondary" id="transit-cancel">Abbrechen</button>
            </div>`;
        document.body.appendChild(d);
        d.querySelector('#transit-save').addEventListener('click', save);
        d.querySelector('#transit-del').addEventListener('click', remove);
        d.querySelector('#transit-cancel').addEventListener('click', () => d.close());
        return d;
    }
    // kind: 'leg' (Etappe idx → idx+1), 'arrival' (Anreise nach der ersten Station), 'return' (Rückreise ab der letzten).
    function openEditor(idx, kind = 'leg') {
        editIdx = idx; editKind = kind;
        if (kind === 'leg' && (!places[idx] || !places[idx + 1])) return;
        if (kind !== 'leg' && !places.length) return;
        const d = dialog(), t = bookingOf(kind, idx) || {};
        const route = kind === 'arrival' ? `Anreise nach ${clean(places[0].name)}`
            : kind === 'return' ? `Rückreise ab ${clean(places[places.length - 1].name)}`
            : `${clean(places[idx].name)} → ${clean(places[idx + 1].name)}`;
        d.querySelector('#transit-route').textContent = route;
        d.querySelector('#modal-transit-title').textContent = kind === 'leg' ? 'Zugverbindung' : kind === 'arrival' ? 'Anreise buchen' : 'Rückreise buchen';
        d.querySelector('#transit-train').value = t.train || '';
        d.querySelector('#transit-dep').value = t.dep || '';
        d.querySelector('#transit-seat').value = t.seat || '';
        d.querySelector('#transit-note').value = t.note || '';
        d.querySelector('#transit-del').hidden = !bookingOf(kind, idx);
        d.showModal();
    }
    function save() {
        const d = dialog();
        const kind = editKind;
        if (kind === 'leg' && !places[editIdx + 1]) { d.close(); return; }
        const previous = bookingOf(kind, editIdx);
        const leg = kind === 'leg' ? places[editIdx + 1] : null;
        const wasOpen = leg && openLegs.has(String(leg.id));
        const v = id => d.querySelector(id).value;
        setBooking(kind, editIdx, normTransit({ train: v('#transit-train'), dep: v('#transit-dep'), seat: v('#transit-seat'), note: v('#transit-note') }));
        if (leg) openLegs.add(String(leg.id));
        const current = bookingOf(kind, editIdx);
        if (!saveData()) {
            setBooking(kind, editIdx, previous);
            if (leg) { if (wasOpen) openLegs.add(String(leg.id)); else openLegs.delete(String(leg.id)); }
            return;
        }
        d.close(); haptic();
        showToast(current ? 'Verbindung gespeichert.' : 'Verbindung entfernt.');
    }
    function remove() {
        const d = dialog(), kind = editKind;
        d.close();
        const prev = bookingOf(kind, editIdx);
        if (!prev) return;
        setBooking(kind, editIdx, null); haptic();
        saveData();
        showUndoToast('Verbindung entfernt.', () => { setBooking(kind, editIdx, prev); saveData(); });
    }

    window.transit = { legEl, renderDayPlan, legInfo, openEditor, bookingOf };
    // Skript lädt nach app.js – evtl. schon gerenderte Listen einmal nachziehen.
    if (typeof places !== 'undefined' && places.length) {
        try { window.renderPlaces?.(); window.renderDayPlan?.(); } catch (e) { console.warn('transit:', e); }
    }
})();
