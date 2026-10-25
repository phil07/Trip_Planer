// ─── KALENDER-EXPORT (.ics, RFC 5545) ─────────────────────────────────────
// Erzeugt aus Stationen (+ optional eingeplanten Aktivitäten des Tagesplans) eine
// iCalendar-Datei. Der Generator (buildIcs & Helfer) ist rein und ohne DOM, damit er
// per Node getestet werden kann (tests/calendar.test.mjs); der UI-Teil greift nur zur
// Laufzeit auf die globalen App-Zustände (places, acts, computedData …) zu.
(function (root) {
    'use strict';

    const CRLF = '\r\n';
    const PRODID = '-//Trip-Planer//Kalender-Export//DE';
    const UID_DOMAIN = 'trip-planer.app';
    // Für Japan bekannt und ohne Sommerzeit → fester VTIMEZONE-Block genügt.
    const TIMEZONES = {
        'Asia/Tokyo': ['BEGIN:VTIMEZONE', 'TZID:Asia/Tokyo', 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
            'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:JST', 'END:STANDARD', 'END:VTIMEZONE']
    };

    // TEXT-Escaping nach RFC 5545 §3.3.11: \ ; , und Zeilenumbrüche.
    function escapeText(s) {
        return String(s ?? '')
            .replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\r\n|\r|\n/g, '\\n')
            // Übrige Steuerzeichen sind in TEXT nicht erlaubt (CONTROL ohne HTAB).
            .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
    }

    // UTF-8-Länge eines einzelnen Codepoints.
    function utf8Len(cp) { return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; }

    // Zeilenfaltung nach §3.1: max. 75 Oktette pro Zeile (ohne CRLF), Fortsetzungszeilen
    // beginnen mit einem Leerzeichen (zählt mit). Iteriert über Codepoints, damit weder
    // UTF-8-Sequenzen noch Surrogatpaare (Emojis) zerteilt werden.
    function foldLine(line) {
        const out = [];
        let cur = '', len = 0, limit = 75;
        for (const ch of String(line)) {
            const n = utf8Len(ch.codePointAt(0));
            if (len + n > limit) {
                out.push(cur);
                cur = ' '; len = 1; limit = 75;
            }
            cur += ch; len += n;
        }
        out.push(cur);
        return out.join(CRLF);
    }

    const pad = n => String(n).padStart(2, '0');
    const isIsoDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
    function parseIso(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
    function isoAddDays(s, n) { const d = parseIso(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
    const icsDate = iso => iso.replace(/-/g, '');
    function icsUtc(date) {
        const d = date instanceof Date && !isNaN(date) ? date : new Date();
        return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    }
    // "9:05" / "09:05" / "0905" → {h, m} oder null.
    function parseTime(t) {
        const m = /^\s*([01]?\d|2[0-3]):?([0-5]\d)\s*$/.exec(String(t ?? ''));
        return m ? { h: +m[1], m: +m[2] } : null;
    }
    // Nur sichere Zeichen in UIDs – IDs stammen aus (evtl. manipulierten) Nutzerdaten.
    const uidPart = s => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'x';

    function prop(name, value) { return foldLine(`${name}:${value}`); }

    // Ein VEVENT. ev = { uid, summary, description, location, start (ISO-Datum), end (ISO, exklusiv),
    //   time:{h,m} optional, durationMin, geo:{lat,lng}, categories }
    function eventLines(ev, opts) {
        const L = ['BEGIN:VEVENT', prop('UID', ev.uid), prop('DTSTAMP', opts.dtstamp)];
        if (ev.time) {
            const startLocal = `${icsDate(ev.start)}T${pad(ev.time.h)}${pad(ev.time.m)}00`;
            const startMin = ev.time.h * 60 + ev.time.m + Math.max(1, Math.round(ev.durationMin || 60));
            const endDay = isoAddDays(ev.start, Math.floor(startMin / 1440));
            const endLocal = `${icsDate(endDay)}T${pad(Math.floor(startMin % 1440 / 60))}${pad(startMin % 60)}00`;
            const tz = opts.tzid ? `;TZID=${opts.tzid}` : '';
            L.push(prop(`DTSTART${tz}`, startLocal), prop(`DTEND${tz}`, endLocal));
        } else {
            L.push(prop('DTSTART;VALUE=DATE', icsDate(ev.start)), prop('DTEND;VALUE=DATE', icsDate(ev.end)));
            L.push('TRANSP:TRANSPARENT'); // ganztägig blockiert nicht den Tag
        }
        L.push(prop('SUMMARY', escapeText(ev.summary)));
        if (ev.location) L.push(prop('LOCATION', escapeText(ev.location)));
        if (ev.description) L.push(prop('DESCRIPTION', escapeText(ev.description)));
        if (ev.categories) L.push(prop('CATEGORIES', escapeText(ev.categories)));
        if (ev.geo && Number.isFinite(ev.geo.lat) && Number.isFinite(ev.geo.lng)
            && Math.abs(ev.geo.lat) <= 90 && Math.abs(ev.geo.lng) <= 180 && !(ev.geo.lat === 0 && ev.geo.lng === 0)) {
            L.push(`GEO:${+ev.geo.lat.toFixed(6)};${+ev.geo.lng.toFixed(6)}`);
        }
        L.push('END:VEVENT');
        return L;
    }

    // data = { tripName, startDate, places:[{id,name,nights,hotel,transport,lat,lng}],
    //          acts:[{id,title,type,desc,notes,topPlace,day,time,duration,lat,lng}] }
    // opts = { includeActivities (bool), tzid ('Asia/Tokyo' | '' für floating), now (Date) }
    // Stationen-Daten: Startdatum + kumulierte Nächte (wie calculateDates() der App).
    function buildIcs(data, opts) {
        opts = Object.assign({ includeActivities: true, tzid: 'Asia/Tokyo', now: new Date() }, opts || {});
        const tzid = opts.tzid && TIMEZONES[opts.tzid] ? opts.tzid : '';
        const o = { dtstamp: icsUtc(opts.now), tzid };
        const places = Array.isArray(data?.places) ? data.places : [];
        const acts = Array.isArray(data?.acts) ? data.acts : [];
        const start = isIsoDate(data?.startDate) ? data.startDate : null;
        const tripName = String(data?.tripName || '').trim() || 'Reise';
        const events = [];
        const cityRanges = {}; // Stadtname → Liste gültiger Tage (für die Aktivitäten-Prüfung)
        let usesTime = false;

        if (start) {
            let cur = start;
            places.forEach((p, i) => {
                const nights = Math.min(365, Math.max(0, Math.round(Number(p?.nights)) || 0));
                const end = isoAddDays(cur, nights);
                const name = String(p?.name ?? '').replace(/ \(Ankunft\)| \(Abreise\)/g, '').trim() || `Station ${i + 1}`;
                (cityRanges[name] ??= []).push([cur, end]);
                const desc = [`${nights} ${nights === 1 ? 'Nacht' : 'Nächte'}`];
                if (p?.hotel) desc.push(`Unterkunft: ${p.hotel}`);
                if (p?.transport && p.transport !== 'Ausstehend' && i > 0) desc.push(`Anreise: ${p.transport}`);
                desc.push(tripName);
                events.push({
                    uid: `station-${uidPart(p?.id ?? i)}@${UID_DOMAIN}`,
                    summary: `📍 ${name}`,
                    location: p?.hotel ? String(p.hotel) : name,
                    description: desc.join('\n'),
                    start: cur,
                    end: nights > 0 ? end : isoAddDays(cur, 1), // DTEND ist exklusiv (Abreisetag)
                    geo: Number.isFinite(p?.hotelLat) && Number.isFinite(p?.hotelLng) ? { lat: p.hotelLat, lng: p.hotelLng }
                        : { lat: Number(p?.lat), lng: Number(p?.lng) },
                    categories: 'Reise'
                });
                cur = end;
            });
        }

        if (opts.includeActivities) {
            const inStay = (city, day) => (cityRanges[city] || []).some(([s, e]) => day >= s && day <= e);
            acts.filter(a => a && isIsoDate(a.day) && (!start || inStay(String(a.topPlace ?? ''), a.day)))
                .sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : (Number(x.dayOrder) || 0) - (Number(y.dayOrder) || 0)))
                .forEach(a => {
                    const time = parseTime(a.time);
                    if (time) usesTime = true;
                    const desc = [a.type, a.desc, a.notes].map(s => String(s ?? '').trim()).filter(Boolean);
                    const lat = Number(a.lat), lng = Number(a.lng);
                    const hasGeo = a.lat != null && a.lng != null && Number.isFinite(lat) && Number.isFinite(lng);
                    if (hasGeo) desc.push(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`);
                    events.push({
                        uid: `act-${uidPart(a.id)}@${UID_DOMAIN}`,
                        summary: String(a.title ?? '').trim() || 'Aktivität',
                        location: [a.title, a.topPlace].map(s => String(s ?? '').trim()).filter(Boolean).join(', '),
                        description: desc.join('\n'),
                        start: a.day,
                        end: isoAddDays(a.day, 1),
                        time,
                        durationMin: Number(a.duration) > 0 ? Math.min(1440, Number(a.duration)) : 60,
                        geo: hasGeo ? { lat, lng } : null,
                        categories: 'Aktivität'
                    });
                });
        }

        const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', prop('PRODID', PRODID), 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
            prop('X-WR-CALNAME', escapeText(tripName))];
        if (tzid) lines.push(prop('X-WR-TIMEZONE', tzid));
        if (tzid && usesTime) lines.push(...TIMEZONES[tzid]);
        events.forEach(ev => lines.push(...eventLines(ev, o)));
        lines.push('END:VCALENDAR');
        return { ics: lines.join(CRLF) + CRLF, count: events.length };
    }

    const api = { buildIcs, escapeText, foldLine, parseTime };

    // ─── UI (nur im Browser) ───────────────────────────────────────────────
    if (typeof document !== 'undefined') {
        const MODE_KEY = 'tp_ics_mode'; // reine UI-Vorliebe, gehört nicht ins Backup

        function currentData() {
            return {
                tripName: typeof tripName === 'string' ? tripName : '',
                startDate: typeof startDate === 'string' ? startDate : '',
                places: typeof places !== 'undefined' ? places : [],
                // Wie im Tagesplan: nur Favoriten, die einem Tag zugeordnet sind.
                acts: typeof acts !== 'undefined' ? acts.filter(a => a.favorite && a.day) : []
            };
        }
        function tzForTrip() {
            const c = typeof tripCountry === 'string' ? tripCountry : '';
            return !c || c === 'Japan' ? 'Asia/Tokyo' : ''; // andere Länder: floating (Ortszeit)
        }
        function ensureDialog() {
            let dlg = document.getElementById('modal-calendar');
            if (dlg) return dlg;
            dlg = document.createElement('dialog');
            dlg.id = 'modal-calendar';
            dlg.setAttribute('aria-labelledby', 'modal-calendar-title');
            dlg.innerHTML = `
                <h3 id="modal-calendar-title">In Kalender exportieren</h3>
                <div class="dialog-body">
                    <p class="cal-hint">Erstellt eine .ics-Datei für Apple-, Google- oder Outlook-Kalender.</p>
                    <div class="cal-options" role="radiogroup" aria-label="Umfang wählen">
                        <label class="cal-option"><input type="radio" name="cal-mode" value="stations"><span><b>Nur Stationen</b><small>Ganztägig über die Aufenthaltsdauer, Hotel als Ort</small></span></label>
                        <label class="cal-option"><input type="radio" name="cal-mode" value="all"><span><b>Stationen + Aktivitäten</b><small id="cal-acts-count">Eingeplante Favoriten aus dem Tagesplan</small></span></label>
                    </div>
                </div>
                <div class="dialog-actions">
                    <button type="button" class="btn" id="cal-export-go">Exportieren</button>
                    <button type="button" class="btn btn-secondary" onclick="this.closest('dialog').close()">Abbrechen</button>
                </div>`;
            dlg.querySelector('#cal-export-go').addEventListener('click', () => {
                const mode = dlg.querySelector('input[name="cal-mode"]:checked')?.value || 'all';
                try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
                dlg.close();
                exportIcs(mode === 'all');
            });
            document.body.appendChild(dlg);
            return dlg;
        }
        function open() {
            if (typeof haptic === 'function') haptic();
            if (typeof places === 'undefined' || !places.length) { showToast('Noch keine Stationen – lege zuerst deine Route an.'); return; }
            const dlg = ensureDialog();
            let mode = 'all';
            try { mode = localStorage.getItem(MODE_KEY) === 'stations' ? 'stations' : 'all'; } catch (e) {}
            dlg.querySelector(`input[value="${mode}"]`).checked = true;
            const n = currentData().acts.length;
            dlg.querySelector('#cal-acts-count').textContent = n
                ? `${n} eingeplante Aktivität${n === 1 ? '' : 'en'} aus dem Tagesplan`
                : 'Noch keine Aktivitäten einem Tag zugeordnet';
            if (typeof toggleMenu === 'function') toggleMenu(false);
            dlg.showModal();
        }
        async function exportIcs(includeActivities) {
            const { ics, count } = buildIcs(currentData(), { includeActivities, tzid: tzForTrip() });
            const slug = (currentData().tripName || 'reise').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
                .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'reise';
            const filename = `${slug}-kalender.ics`;
            const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
            const label = `${count} Termin${count === 1 ? '' : 'e'}`;
            // Mobil: Teilen-Dialog → direkt „Zum Kalender hinzufügen“ möglich.
            const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
                || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
            if (mobile && typeof File === 'function' && navigator.canShare && navigator.share) {
                try {
                    const file = new File([blob], filename, { type: 'text/calendar' });
                    if (navigator.canShare({ files: [file] })) {
                        await navigator.share({ files: [file], title: currentData().tripName || 'Reise' });
                        showToast(`📅 Kalender geteilt (${label})`);
                        return;
                    }
                } catch (e) {
                    if (e && e.name === 'AbortError') return; // Nutzer hat abgebrochen
                    console.warn('Kalender teilen fehlgeschlagen, lade stattdessen herunter', e);
                }
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            showToast(`📅 Kalender heruntergeladen (${label})`);
        }
        // Hook aus renderDayPlan(): Export-Button oben im Tagesplan.
        function decorateDayPlan(list) {
            if (!list || typeof places === 'undefined' || !places.length) return;
            const bar = document.createElement('div');
            bar.className = 'cal-dayplan-bar';
            bar.innerHTML = '<button type="button" class="btn-icon cal-export-btn"><i class="ph-light ph-calendar-plus" data-fb="📅" aria-hidden="true"></i> In Kalender exportieren</button>';
            bar.querySelector('button').addEventListener('click', open);
            list.prepend(bar);
        }
        Object.assign(api, { open, exportIcs, decorateDayPlan });
        root.calendarExport = api;
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
