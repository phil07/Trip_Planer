// ─── WETTER PRO STATION (Open-Meteo) ────────────────────────────────────
// Kompakte Wetterkarte auf der Startseite (aktuelle/nächste Station) und Tageswetter
// in den Reisetag-Karten des Tagesplans. Open-Meteo ist kostenlos und ohne Key.
// Ergebnisse landen in einem eigenen localStorage-Cache (3 h frisch, offline auch älter) –
// reiner Cache, gehört nicht ins Backup. Nutzt die globalen Helfer/State aus app.js
// (places, computedData, tripCountry, esc, clean, nominatimFetch, fetchWithTimeout …).
(function () {
    'use strict';
    const CACHE_KEY = 'tp_weather_cache';
    const TTL_MS = 3 * 60 * 60 * 1000;
    const GEO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const FORECAST_DAYS = 16;          // Open-Meteo-Maximum: heute + 15 Tage
    const HOME_DAYS = 5;
    const RAIN_PCT = 60;
    const MAX_ENTRIES = 24;
    const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

    // WMO-Wettercode → Phosphor-Icon, Ersatz-Emoji, Text
    function wxInfo(code) {
        const c = Number(code);
        if (c === 0) return ['sun', '☀️', 'Sonnig'];
        if (c === 1) return ['cloud-sun', '🌤️', 'Überwiegend sonnig'];
        if (c === 2) return ['cloud-sun', '⛅', 'Teils bewölkt'];
        if (c === 3) return ['cloud', '☁️', 'Bedeckt'];
        if (c === 45 || c === 48) return ['cloud-fog', '🌫️', 'Nebel'];
        if (c >= 51 && c <= 57) return ['cloud-rain', '🌦️', 'Nieselregen'];
        if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return ['cloud-rain', '🌧️', 'Regen'];
        if ((c >= 71 && c <= 77) || c === 85 || c === 86) return ['cloud-snow', '❄️', 'Schnee'];
        if (c >= 95 && c <= 99) return ['cloud-lightning', '⛈️', 'Gewitter'];
        return ['thermometer', '🌡️', 'Wetter'];
    }

    // ── Cache (defensiv normalisiert: nur Zahlen/ISO-Daten übernehmen) ──
    const num = (v, lo, hi) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
    function normDay(d) {
        if (!isObj(d) || typeof d.d !== 'string' || !ISO_RE.test(d.d)) return null;
        return { d: d.d, code: num(d.code, 0, 99), tmin: num(d.tmin, -90, 70), tmax: num(d.tmax, -90, 70), pop: num(d.pop, 0, 100) };
    }
    function loadCache() {
        const raw = readJsonKey(CACHE_KEY, isObj, {});
        const out = { geo: {}, fc: {} };
        if (isObj(raw.geo)) Object.keys(raw.geo).slice(0, MAX_ENTRIES * 2).forEach(k => {
            const g = raw.geo[k];
            if (!isObj(g)) return;
            const lat = num(g.lat, -90, 90), lng = num(g.lng, -180, 180), t = num(g.t, 0, 1e15);
            if (lat !== null && lng !== null && t !== null) out.geo[String(k).slice(0, 120)] = { lat, lng, t };
        });
        if (isObj(raw.fc)) Object.keys(raw.fc).slice(0, MAX_ENTRIES * 2).forEach(k => {
            const f = raw.fc[k];
            if (!isObj(f) || !Array.isArray(f.days)) return;
            const t = num(f.t, 0, 1e15);
            const days = f.days.slice(0, 20).map(normDay).filter(Boolean);
            if (t !== null && days.length) out.fc[String(k).slice(0, 40)] = { t, days };
        });
        return out;
    }
    function prune(map) {
        const keys = Object.keys(map).sort((a, b) => map[b].t - map[a].t);
        keys.slice(MAX_ENTRIES).forEach(k => delete map[k]);
    }
    function saveCache(c) { prune(c.geo); prune(c.fc); writeJson(CACHE_KEY, c); }

    // ── Koordinaten einer Station: aus dem Place-Objekt, sonst per Nominatim (gecacht) ──
    const geoKey = p => (clean(p.name).trim() + '|' + (tripCountry || '')).toLowerCase();
    const hasCoords = p => typeof p.lat === 'number' && typeof p.lng === 'number' && (p.lat !== 0 || p.lng !== 0)
        && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
    function cachedCoords(p) {
        if (hasCoords(p)) return { lat: p.lat, lng: p.lng };
        return loadCache().geo[geoKey(p)] || null;
    }
    const geoInflight = {};
    async function resolveCoords(p) {
        const known = cachedCoords(p);
        if (known && (hasCoords(p) || Date.now() - known.t < GEO_TTL_MS)) return known;
        const key = geoKey(p), name = clean(p.name).trim();
        if (!name || !navigator.onLine) return known;
        if (!geoInflight[key]) geoInflight[key] = (async () => {
            try {
                const q = [name, tripCountry].filter(Boolean).join(', ');
                const r = await nominatimFetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`);
                const d = await r.json();
                const lat = Array.isArray(d) && d[0] ? num(parseFloat(d[0].lat), -90, 90) : null;
                const lng = Array.isArray(d) && d[0] ? num(parseFloat(d[0].lon), -180, 180) : null;
                if (lat === null || lng === null) return null;
                const c = loadCache(); c.geo[key] = { lat, lng, t: Date.now() }; saveCache(c);
                return c.geo[key];
            } catch (e) { return null; } finally { delete geoInflight[key]; }
        })();
        return (await geoInflight[key]) || known;
    }

    // ── Vorhersage holen (pro gerundeter Koordinate gecacht) ──
    const fcKey = g => `${g.lat.toFixed(2)},${g.lng.toFixed(2)}`;
    const fcInflight = {};
    let warned = false;
    async function fetchForecast(g) {
        const key = fcKey(g);
        const cached = loadCache().fc[key];
        if (cached && Date.now() - cached.t < TTL_MS) return cached;
        if (!navigator.onLine) return cached || null;
        if (!fcInflight[key]) fcInflight[key] = (async () => {
            try {
                const url = `https://api.open-meteo.com/v1/forecast?latitude=${g.lat.toFixed(4)}&longitude=${g.lng.toFixed(4)}`
                    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${FORECAST_DAYS}`;
                const r = await fetchWithTimeout(url, 10000);
                if (!r.ok) throw new Error('http ' + r.status);
                const j = await r.json();
                const dl = isObj(j) && isObj(j.daily) ? j.daily : {};
                const times = Array.isArray(dl.time) ? dl.time : [];
                const at = (arr, i) => Array.isArray(arr) ? arr[i] : null;
                const days = times.slice(0, 20).map((d, i) => normDay({ d, code: at(dl.weather_code, i),
                    tmin: at(dl.temperature_2m_min, i), tmax: at(dl.temperature_2m_max, i),
                    pop: at(dl.precipitation_probability_max, i) })).filter(Boolean);
                if (!days.length) throw new Error('leere Vorhersage');
                const c = loadCache(); c.fc[key] = { t: Date.now(), days }; saveCache(c);
                warned = false;
                return c.fc[key];
            } catch (e) {
                if (!warned) { warned = true; console.warn('Wetter: Vorhersage nicht ladbar', e?.message || e); }
                return null;
            } finally { delete fcInflight[key]; }
        })();
        return (await fcInflight[key]) || cached || null;
    }
    // Synchron aus dem Cache (für sofortiges Rendern), unabhängig vom Alter.
    function cachedForecast(p) {
        const g = cachedCoords(p);
        return g ? loadCache().fc[fcKey(g)] || null : null;
    }
    const isFresh = f => !!f && Date.now() - f.t < TTL_MS;

    // ── Hilfen für Daten/Darstellung ──
    const dayDiff = iso => Math.round((parseISODate(iso) - parseISODate(todayISO())) / 864e5);
    const fmtT = v => v === null ? '–' : `${Math.round(v)}°`;
    const fmtWd = iso => parseISODate(iso).toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');
    const isRain = d => d && d.pop !== null && d.pop >= RAIN_PCT;
    function standHtml(f) {
        if (!f) return '';
        const t = new Date(f.t);
        const hm = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const day = localISO(t) === todayISO() ? '' : t.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ';
        return `Stand ${esc(day + hm)}${!navigator.onLine ? ' · offline' : !isFresh(f) ? ' · veraltet' : ''}`;
    }
    const rainHint = txt => `<div class="wx-rain-hint" role="note">${ico('umbrella', '☔')}<span>${esc(txt)}</span></div>`;

    // Station für einen Reisetag: zuerst nach Stadtname, sonst nach Datum.
    function placeFor(city, iso) {
        const i = places.findIndex(p => clean(p.name) === city);
        if (i >= 0) return places[i];
        const j = computedData.findIndex(c => c && c.isoStart <= iso && iso < c.isoEnd);
        return j >= 0 ? places[j] : places[places.length - 1] || null;
    }
    // Aktuelle/nächste Station – gleiche Logik wie die „Als Nächstes“-Karte in renderHome().
    function homeStation() {
        if (!places.length) return null;
        const today = todayISO();
        let idx = computedData.findIndex(c => c && c.isoEnd > today);
        if (idx < 0 || idx >= places.length) idx = 0;
        const cd = computedData[idx];
        return cd ? { p: places[idx], idx, cd } : null;
    }

    // ── Startseite ──
    function renderHomeCard() {
        const box = document.getElementById('homeWeather');
        if (!box) return;
        const st = homeStation();
        if (!st) { box.hidden = true; box.innerHTML = ''; return; }
        box.hidden = false;
        const today = todayISO();
        const from = st.cd.isoStart > today ? st.cd.isoStart : today;
        const title = `Wetter · ${esc(clean(st.p.name))}`;
        const lead = dayDiff(from);
        const head = (meta) => `<div class="wx-head"><span class="wx-title">${ico('cloud-sun', '⛅')}<span>${title}</span></span><span class="wx-meta">${meta}</span></div>`;
        if (lead >= FORECAST_DAYS) {
            box.innerHTML = head('') + `<div class="wx-note">Vorhersage ab ${FORECAST_DAYS} Tage vorher – noch ${lead - FORECAST_DAYS + 1} ${lead - FORECAST_DAYS + 1 === 1 ? 'Tag' : 'Tage'} warten.</div>`;
            return;
        }
        const f = cachedForecast(st.p);
        // Ab Ankunft bzw. heute bis zum Abreisetag, höchstens HOME_DAYS Tage.
        const days = f ? f.days.filter(d => d.d >= from && d.d <= st.cd.isoEnd).slice(0, HOME_DAYS) : [];
        if (!days.length) {
            box.innerHTML = head('') + `<div class="wx-note">${!navigator.onLine ? 'Offline – noch keine Wetterdaten gespeichert.' : 'Wetter wird geladen …'}</div>`;
        } else {
            const rainy = days.filter(isRain);
            box.innerHTML = head(standHtml(f)) + `<div class="wx-days">${days.map(d => {
                const [icon, fb, label] = wxInfo(d.code);
                const lbl = d.d === today ? 'Heute' : fmtWd(d.d);
                return `<div class="wx-day${isRain(d) ? ' wx-day-rain' : ''}" title="${esc(label)}">
                    <span class="wx-day-lbl">${esc(lbl)}</span>
                    <span class="wx-ico" role="img" aria-label="${esc(label)}">${ico(icon, fb)}</span>
                    <span class="wx-temp"><b>${fmtT(d.tmax)}</b> <span>${fmtT(d.tmin)}</span></span>
                    <span class="wx-pop">${ico('drop', '💧')}${d.pop === null ? '–' : esc(String(Math.round(d.pop))) + ' %'}</span>
                </div>`; }).join('')}</div>`
                + (rainy.length ? rainHint(`Regentag${rainy.length > 1 ? 'e' : ''} (${rainy.map(d => d.d === today ? 'heute' : fmtWd(d.d)).join(', ')}) – Indoor-Aktivitäten einplanen`) : '');
        }
        if (!isFresh(f)) loadFor(st.p);
    }

    // ── Tagesplan: Wetterzeile in jede Reisetag-Karte ──
    function renderDayPlanCards(root) {
        const list = root || document.getElementById('dayPlanList');
        if (!list) return;
        const need = new Set();
        list.querySelectorAll('.dayplan-card[data-wx-day]').forEach(card => {
            const iso = card.dataset.wxDay;
            if (!ISO_RE.test(iso)) return;
            let box = card.querySelector('.wx-dayplan');
            if (!box) {
                box = document.createElement('div');
                box.className = 'wx-dayplan';
                card.querySelector('.dayplan-header')?.after(box);
            }
            const lead = dayDiff(iso);
            if (lead < 0) { box.remove(); return; }
            if (lead >= FORECAST_DAYS) {
                box.innerHTML = `<div class="wx-note">${ico('cloud-sun', '⛅')} Vorhersage ab ${FORECAST_DAYS} Tage vorher</div>`;
                return;
            }
            const p = placeFor(card.dataset.wxCity || '', iso);
            if (!p) { box.remove(); return; }
            const f = cachedForecast(p);
            const d = f && f.days.find(x => x.d === iso);
            if (!d) {
                box.innerHTML = `<div class="wx-note">${!navigator.onLine ? 'Offline – kein Wetter gespeichert' : 'Wetter wird geladen …'}</div>`;
            } else {
                const [icon, fb, label] = wxInfo(d.code);
                box.innerHTML = `<div class="wx-line">
                        <span class="wx-ico" aria-hidden="true">${ico(icon, fb)}</span>
                        <span class="wx-line-txt"><b>${esc(label)}</b> · ${fmtT(d.tmax)} / ${fmtT(d.tmin)}</span>
                        <span class="wx-pop">${ico('drop', '💧')}${d.pop === null ? '–' : esc(String(Math.round(d.pop))) + ' %'}</span>
                    </div>${isRain(d) ? rainHint('Regentag – Indoor-Aktivitäten einplanen') : ''}`;
            }
            if (!isFresh(f)) need.add(p);
        });
        need.forEach(loadFor);
    }

    // Lädt Koordinaten + Vorhersage im Hintergrund und rendert danach neu.
    const loading = new Set();
    async function loadFor(p) {
        const k = geoKey(p);
        if (loading.has(k) || !navigator.onLine) return;
        loading.add(k);
        try {
            const g = await resolveCoords(p);
            if (!g) return;
            const before = loadCache().fc[fcKey(g)]?.t;
            const f = await fetchForecast(g);
            if (f && f.t !== before) { renderHomeCard(); renderDayPlanCards(); }
        } finally { loading.delete(k); }
    }

    function refresh() { try { renderHomeCard(); renderDayPlanCards(); } catch (e) { console.warn('Wetter: Render fehlgeschlagen', e); } }
    window.weatherFeature = { renderHome: renderHomeCard, renderDayPlan: renderDayPlanCards, refresh };
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    // app.js hat beim ersten Rendern evtl. noch keinen Hook gefunden (Skript-Reihenfolge).
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh, { once: true });
    else refresh();
})();
