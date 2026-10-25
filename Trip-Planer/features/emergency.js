// ─── NOTFALL-INFOS (je Reiseland) ───────────────────────────────────────────
// Notrufnummern des Reiselandes + Notfall-Sätze (groß anzeigbar) und ein persönlicher
// Notfall-Ausweis (tp_emergency, nur lokal + im Backup). Japan ist komplett offline
// hinterlegt; für andere Länder werden die Sätze einmalig übersetzt und gecacht.
// Nutzt die globalen Helfer/Zustände aus app.js: esc, isObj, readJsonKey, writeJson, showToast,
// haptic, switchView, speakPhrase, fetchWithTimeout, mapPool, tripCountry, tripLangCode.
(function () {
    'use strict';
    const KEY = 'tp_emergency';

    // Feste Nummern (geprüft 10/2026: Auswärtiges Amt, JNTO).
    const HOTLINES = [
        { icon: 'police-car', fb: '🚓', title: 'Polizei', sub: 'Diebstahl, Unfall, Bedrohung', show: '110', tel: '110', urgent: true },
        { icon: 'ambulance', fb: '🚑', title: 'Feuerwehr & Rettungsdienst', sub: 'Krankenwagen, Feuer', show: '119', tel: '119', urgent: true },
        { icon: 'headset', fb: '☎️', title: 'Japan Visitor Hotline', sub: 'JNTO · 24/7 · Englisch', show: '050-3816-2787', tel: '+815038162787' },
        { icon: 'bank', fb: '🏛️', title: 'Deutsche Botschaft Tokio', sub: 'Konsularische Hilfe, Passverlust', show: '+81 3 5791 7700', tel: '+81357917700' },
        { icon: 'bank', fb: '🏛️', title: 'Generalkonsulat Osaka-Kobe', sub: 'Westjapan (Kansai)', show: '+81 6 6440 5070', tel: '+81664405070' },
        { icon: 'siren', fb: '🆘', title: 'Notfall-Bereitschaft Botschaft/Konsulat', sub: 'Außerhalb der Öffnungszeiten · keine Visa-/Terminfragen', show: '+81 90 1708 4823', tel: '+819017084823' },
        { icon: 'credit-card', fb: '💳', title: 'Sperr-Notruf Karten', sub: 'Aus dem Ausland · in DE: 116 116', show: '+49 116 116', tel: '+49116116' }
    ];

    // Notrufnummern weiterer Länder: e = allgemein, p = Polizei, a = Rettung, f = Feuerwehr,
    // t = Touristenpolizei, g = Gendarmerie (ländlich).
    // Stand 10/2026, abgeglichen mit Wikipedia „List of emergency telephone numbers“. Gleiche Nummern werden zu einer Kachel zusammengefasst.
    const NUMBERS = {
        'Japan': { p: '110', a: '119', f: '119' },
        'Italien': { e: '112', p: '113', a: '118', f: '115' },
        'Frankreich': { e: '112', p: '17', a: '15', f: '18' },
        'Spanien': { e: '112', p: '091' },
        'Portugal': { e: '112' },
        'Griechenland': { e: '112', p: '100', a: '166', f: '199', t: '1571' },
        'Türkei': { e: '112' },
        'Kroatien': { e: '112', p: '192', a: '194', f: '193' },
        'Niederlande': { e: '112' },
        'Österreich': { e: '112', p: '133', a: '144', f: '122' },
        'Schweiz': { e: '112', p: '117', a: '144', f: '118' },
        'Deutschland': { p: '110', a: '112', f: '112' },
        'Polen': { e: '112', p: '997', a: '999', f: '998' },
        'Tschechien': { e: '112', p: '158', a: '155', f: '150' },
        'Ungarn': { e: '112', p: '107', a: '104', f: '105' },
        'Schweden': { e: '112' },
        'Norwegen': { p: '112', a: '113', f: '110' },
        'Dänemark': { e: '112' },
        'Finnland': { e: '112' },
        'Island': { e: '112' },
        'Vereinigtes Königreich': { e: '999' },
        'USA': { e: '911' },
        'Kanada': { e: '911' },
        'Mexiko': { e: '911' },
        'Brasilien': { p: '190', a: '192', f: '193' },
        'Argentinien': { e: '911', p: '101', a: '107', f: '100' },
        'Peru': { e: '911', p: '105', a: '106', f: '116' },
        'China': { p: '110', a: '120', f: '119' },
        'Südkorea': { p: '112', a: '119', f: '119' },
        'Taiwan': { p: '110', a: '119', f: '119' },
        'Thailand': { p: '191', a: '1669', f: '199', t: '1155' },
        'Vietnam': { p: '113', a: '115', f: '114' },
        'Indonesien': { e: '112', p: '110', a: '118', f: '113' },
        'Malaysia': { e: '999' },
        'Philippinen': { e: '911' },
        'Indien': { e: '112', p: '100', a: '108', f: '101' },
        'Vereinigte Arabische Emirate': { p: '999', a: '998', f: '997' },
        'Ägypten': { p: '122', a: '123', f: '180', t: '126' },
        'Marokko': { e: '112', p: '19', a: '15', f: '15', g: '177' },
        'Israel': { p: '100', a: '101', f: '102' },
        'Südafrika': { e: '112', p: '10111', a: '10177' },
        'Australien': { e: '000' },
        'Neuseeland': { e: '111' },
        'Russland': { e: '112', p: '102', a: '103', f: '101' }
    };
    const KINDS = { e: ['siren', '🆘', 'Notruf'], p: ['police-car', '🚓', 'Polizei'], a: ['ambulance', '🚑', 'Rettungsdienst'],
        f: ['fire-truck', '🚒', 'Feuerwehr'], t: ['police-car', '👮', 'Touristenpolizei'], g: ['police-car', '👮', 'Gendarmerie (ländlich)'] };
    // Kacheln: gleiche Nummer → eine Kachel ("Rettungsdienst & Feuerwehr"); unbekanntes Land → 112.
    function urgentFor(country) {
        const n = NUMBERS[country] || { e: '112' }, by = new Map();
        Object.keys(KINDS).forEach(k => {
            if (!n[k]) return;
            if (!by.has(n[k])) by.set(n[k], { num: n[k], kinds: [] });
            by.get(n[k]).kinds.push(k);
        });
        return [...by.values()].map(({ num, kinds }) => ({ icon: KINDS[kinds[0]][0], fb: KINDS[kinds[0]][1],
            title: kinds.map(k => KINDS[k][2]).join(' & '), show: num, tel: num, urgent: true }));
    }
    const ABROAD = [
        { icon: 'bank', fb: '🏛️', title: 'Auswärtiges Amt · Notfälle', sub: 'Zentrale Berlin · rund um die Uhr, z. B. Passverlust', show: '+49 30 5000 0', tel: '+4930500000' },
        { icon: 'credit-card', fb: '💳', title: 'Sperr-Notruf Karten', sub: 'Aus dem Ausland · in DE: 116 116', show: '+49 116 116', tel: '+49116116' }
    ];

    // Notfall-Sätze: [Japanisch, Lautschrift, Deutsch]
    const SENTENCES = [
        ['救急車を呼んでください。', 'Kyūkyūsha o yonde kudasai.', 'Bitte rufen Sie einen Krankenwagen.'],
        ['助けてください！', 'Tasukete kudasai!', 'Hilfe, bitte helfen Sie mir!'],
        ['警察を呼んでください。', 'Keisatsu o yonde kudasai.', 'Bitte rufen Sie die Polizei.'],
        ['一番近い病院はどこですか？', 'Ichiban chikai byōin wa doko desu ka?', 'Wo ist das nächste Krankenhaus?'],
        ['英語を話せるお医者さんはいますか？', 'Eigo o hanaseru o-isha-san wa imasu ka?', 'Gibt es einen Arzt, der Englisch spricht?'],
        ['一番近い薬局はどこですか？', 'Ichiban chikai yakkyoku wa doko desu ka?', 'Wo ist die nächste Apotheke?'],
        ['気分が悪いです。', 'Kibun ga warui desu.', 'Mir geht es nicht gut.'],
        ['ここが痛いです。', 'Koko ga itai desu.', 'Es tut hier weh.'],
        ['パスポートをなくしました。', 'Pasupōto o nakushimashita.', 'Ich habe meinen Reisepass verloren.'],
        ['財布を盗まれました。', 'Saifu o nusumaremashita.', 'Mein Portemonnaie wurde gestohlen.'],
        ['避難所はどこですか？', 'Hinanjo wa doko desu ka?', 'Wo ist die Notunterkunft (z. B. bei Erdbeben)?'],
        ['火事です！', 'Kaji desu!', 'Es brennt!']
    ];
    // Allergie-Satz mit wählbarem Auslöser: [Japanisch, Lautschrift, Deutsch]
    const ALLERGENS = [
        ['卵', 'tamago', 'Ei'], ['牛乳', 'gyūnyū', 'Milch'], ['小麦', 'komugi', 'Weizen'], ['そば', 'soba', 'Buchweizen'],
        ['ピーナッツ', 'pīnattsu', 'Erdnüsse'], ['ナッツ', 'nattsu', 'Nüsse'], ['えび', 'ebi', 'Garnelen'], ['かに', 'kani', 'Krebs'],
        ['魚', 'sakana', 'Fisch'], ['貝', 'kai', 'Muscheln'], ['大豆', 'daizu', 'Soja'], ['ごま', 'goma', 'Sesam'],
        ['ペニシリン', 'penishirin', 'Penicillin']
    ];
    const allergySentence = a => a
        ? [`私は${a[0]}アレルギーがあります。`, `Watashi wa ${a[1]} arerugī ga arimasu.`, `Ich habe eine Allergie gegen ${a[2]}.`]
        : ['私はアレルギーがあります。', 'Watashi wa arerugī ga arimasu.', 'Ich habe eine Allergie gegen …'];

    // Persönliche Felder: [Schlüssel, Label, japanisches Label (für den Ausweis), Typ, max. Länge, Platzhalter]
    const FIELDS = [
        ['name', 'Name', '名前', 'text', 80, 'Vor- und Nachname'],
        ['blood', 'Blutgruppe', '血液型', 'blood', 0, ''],
        ['allergies', 'Allergien', 'アレルギー', 'area', 300, 'z. B. Penicillin, Erdnüsse'],
        ['meds', 'Medikamente', '服用中の薬', 'area', 300, 'Name + Dosierung'],
        ['conditions', 'Vorerkrankungen', '持病', 'area', 300, 'z. B. Asthma, Diabetes'],
        ['insurer', 'Krankenversicherung', '保険会社', 'text', 100, 'Name des Versicherers'],
        ['policy', 'Versicherungsnummer', '保険番号', 'text', 60, 'Mitglieds-/Policennummer'],
        ['insurerPhone', 'Notfallnummer der Versicherung', '保険会社の緊急連絡先', 'tel', 40, '+49 …'],
        ['bankPhone', 'Eigene Karten-/Bank-Hotline (optional)', 'カード会社', 'tel', 40, 'Zusätzlich zu +49 116 116'],
        ['contactName', 'Notfallkontakt zuhause', '緊急連絡先', 'text', 80, 'Name, Beziehung'],
        ['contactPhone', 'Telefon Notfallkontakt', '緊急連絡先の電話', 'tel', 40, '+49 …']
    ];
    const BLOOD = ['', 'A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', '0+', '0−'];
    const BLOOD_JA = { 'A+': 'A型 Rh+', 'A−': 'A型 Rh−', 'B+': 'B型 Rh+', 'B−': 'B型 Rh−', 'AB+': 'AB型 Rh+', 'AB−': 'AB型 Rh−', '0+': 'O型 Rh+', '0−': 'O型 Rh−' };

    // Defensiv normalisieren: nur bekannte Felder, nur Strings, begrenzte Länge, Blutgruppe aus fester Liste.
    function normalize(raw) {
        const o = {};
        const src = isObj(raw) ? raw : {};
        FIELDS.forEach(([k, , , type, max]) => {
            if (type === 'blood') {
                const v = String(src[k] ?? '').replace('-', '−');
                o[k] = BLOOD.includes(v) ? v : '';
            } else {
                o[k] = typeof src[k] === 'string' ? src[k].replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max) : '';
            }
        });
        return o;
    }
    const load = () => normalize(readJsonKey(KEY, isObj, {}));
    // tel:-Ziel nur aus Ziffern und führendem +; sonst kein Link.
    function telHref(s) {
        const t = String(s || '').trim();
        const digits = t.replace(/[^\d]/g, '');
        if (digits.length < 3 || digits.length > 18) return '';
        return 'tel:' + (t.startsWith('+') ? '+' : t.startsWith('00') ? '+' : '') + (t.startsWith('00') ? digits.slice(2) : digits);
    }
    const ico = (n, fb) => `<i class="ph-light ph-${n}" data-fb="${fb}" aria-hidden="true"></i>`;

    // ── Reiseland + übersetzte Sätze ──────────────────────────────────────────
    function ctx() {
        const country = typeof tripCountry === 'string' ? tripCountry.trim() : '';
        // Ohne Reiseland gilt – wie bei Taxi-Karte und Kalender – Japan (Standard der App).
        if (!country) return { country: 'Japan', lang: 'ja', ja: true };
        const lang = typeof tripLangCode === 'string' && tripLangCode ? tripLangCode : 'en';
        return { country, lang, ja: lang === 'ja' };
    }
    // Ausgangstexte (Deutsch) für Nicht-Japan-Länder: Sätze, Allergie-Sätze, Ausweis-Überschrift + Labels.
    const SRC = [...SENTENCES.map(s => s[2].replace(' (z. B. bei Erdbeben)', '')), 'Ich habe eine Allergie.',
        ...ALLERGENS.map(a => `Ich habe eine Allergie gegen ${a[2]}.`), 'Notfall-Ausweis', ...FIELDS.map(f => f[1])];
    const I_ALLERGY = SENTENCES.length, I_CARD = I_ALLERGY + 1 + ALLERGENS.length, I_LABELS = I_CARD + 1;
    const trMem = {}, trBusy = {};
    function trCached(lang) {
        if (lang === 'de') return SRC;
        if (trMem[lang]) return trMem[lang];
        try {
            const c = JSON.parse(localStorage.getItem('tp_emsent_' + lang));
            if (Array.isArray(c) && c.length === SRC.length && c.every(x => typeof x === 'string')) return (trMem[lang] = c);
        } catch (e) {}
        return null;
    }
    async function translate(lang) {
        if (trBusy[lang]) return;
        trBusy[lang] = true;
        try {
            const out = await mapPool(SRC, 4, async t => {
                try {
                    const res = await fetchWithTimeout(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=de&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(t)}`, 6000);
                    const d = await res.json();
                    return (d?.[0] || []).map(x => x[0]).join('').trim().slice(0, 300) || null;
                } catch (e) { return null; }
            });
            // Nur vollständig cachen – sonst bliebe ein deutscher Rest dauerhaft hängen.
            if (out.every(Boolean)) {
                trMem[lang] = out;
                try { localStorage.setItem('tp_emsent_' + lang, JSON.stringify(out)); } catch (e) {}
            } else window.addEventListener('online', () => { if (ctx().lang === lang) render(); }, { once: true });
        } finally { trBusy[lang] = false; }
        if (ctx().lang === lang) render();
    }
    // Aktuelle Satzliste je Land: [Landessprache, Lautschrift, Deutsch]
    let cur = { ja: true, sent: SENTENCES, tr: null };
    const allergyFor = i => cur.ja ? allergySentence(i == null ? null : ALLERGENS[i])
        : i == null ? [cur.tr ? cur.tr[I_ALLERGY] : 'Ich habe eine Allergie.', '', 'Ich habe eine Allergie gegen …']
        : [cur.tr ? cur.tr[I_ALLERGY + 1 + i] : SRC[I_ALLERGY + 1 + i], '', SRC[I_ALLERGY + 1 + i]];

    function render() {
        const cont = document.getElementById('emergencyContent');
        if (!cont) return;
        const d = load(), c = ctx();
        const tr = c.ja ? null : trCached(c.lang);
        cur = { ja: c.ja, tr, sent: c.ja ? SENTENCES : SENTENCES.map((s, i) => [tr ? tr[i] : SRC[i], '', SRC[i]]) };
        if (!c.ja && !tr) translate(c.lang);
        const hotlines = c.ja ? HOTLINES : [...urgentFor(c.country), ...ABROAD];
        const known = c.ja || !!NUMBERS[c.country];
        const where = c.country ? (c.ja ? 'Japan' : c.country) : 'im Ausland';
        const firstNum = hotlines.find(h => h.urgent)?.show || '112';
        const intro = c.ja
            ? '<strong>Im Notfall in Japan</strong><br>Notrufe 110/119 sind kostenlos und auch ohne SIM erreichbar. Tippe auf eine Nummer, um anzurufen.'
            : `<strong>Im Notfall ${c.country ? 'in ' + esc(where) : 'im Ausland'}</strong><br>${known
                ? 'Notrufe sind kostenlos. Tippe auf eine Nummer, um anzurufen.'
                : 'Für dieses Reiseland sind keine Nummern hinterlegt – die 112 leiten die meisten Handys an den örtlichen Notruf weiter.'}`;
        const hasPersonal = FIELDS.some(([k]) => d[k]);
        cont.innerHTML = `
            <div class="em-intro">
                <span class="em-intro-ico">${ico('first-aid', '🆘')}</span>
                <div>${intro}</div>
            </div>
            <div class="em-grid">
                ${hotlines.filter(h => h.urgent).map(h => `
                <a class="em-call urgent" href="tel:${esc(h.tel.replace(/\s/g, ''))}" aria-label="${esc(h.title)} anrufen: ${esc(h.show)}">
                    <span class="em-call-num">${esc(h.show)}</span>
                    <span class="em-call-title">${ico(h.icon, h.fb)} ${esc(h.title)}</span>
                </a>`).join('')}
            </div>
            <div class="em-card">
                <div class="home-card-title">Wichtige Nummern</div>
                ${hotlines.filter(h => !h.urgent).map(h => `
                <a class="em-row" href="tel:${esc(h.tel.replace(/\s/g, ''))}" aria-label="${esc(h.title)} anrufen: ${esc(h.show)}">
                    <span class="em-row-ico">${ico(h.icon, h.fb)}</span>
                    <span class="em-row-text"><span class="em-row-title">${esc(h.title)}</span><span class="em-row-sub">${esc(h.sub)}</span></span>
                    <span class="em-row-num">${esc(h.show)}</span>
                </a>`).join('')}
                <div class="em-note">Karten-Sperrnotruf: in Deutschland <a href="tel:116116">116 116</a>, aus dem Ausland <a href="tel:+49116116">+49 116 116</a>.</div>
            </div>
            <div class="em-card">
                <div class="home-card-title">Notfall-Sätze</div>
                <div class="em-hint">${c.ja || tr ? 'Antippen zeigt den Satz groß – Display dem Gegenüber zeigen.'
                    : navigator.onLine === false ? '⚠️ Offline – Sätze werden übersetzt, sobald eine Verbindung besteht.' : 'Übersetze Notfall-Sätze …'}</div>
                ${cur.sent.map((s, i) => `
                <button type="button" class="em-phrase" data-idx="${i}">
                    <span class="em-phrase-jp" lang="${esc(c.lang)}">${esc(s[0])}</span>
                    <span class="em-phrase-de">${esc(s[2])}</span>
                </button>`).join('')}
                <button type="button" class="em-phrase" data-allergy="1">
                    <span class="em-phrase-jp" lang="${esc(c.lang)}">${c.ja ? '私は〇〇アレルギーがあります。' : esc(allergyFor(null)[0])}</span>
                    <span class="em-phrase-de">Ich habe eine Allergie gegen … (Auslöser wählbar)</span>
                </button>
            </div>
            <div class="em-card">
                <div class="em-card-head">
                    <div class="home-card-title">Mein Notfall-Ausweis</div>
                    <button type="button" class="em-edit-btn" id="emEditBtn">${ico('pencil-simple', '✏️')} Bearbeiten</button>
                </div>
                ${hasPersonal ? `
                <dl class="em-dl">
                    ${FIELDS.filter(([k]) => d[k]).map(([k, label, , type]) => {
                        const href = type === 'tel' ? telHref(d[k]) : '';
                        const val = href ? `<a href="${esc(href)}">${esc(d[k])}</a>` : esc(d[k]);
                        return `<div class="em-dl-row"><dt>${esc(label)}</dt><dd>${val}</dd></div>`;
                    }).join('')}
                </dl>
                <button type="button" class="btn" id="emShowCard">${ico('identification-card', '🪪')} Ausweis groß zeigen${c.ja ? ' (日本語)' : ''}</button>` : `
                <div class="em-empty">Noch leer. Trage Blutgruppe, Allergien, Medikamente, Versicherung und einen Notfallkontakt ein – alles bleibt nur auf diesem Gerät (und in deinem Backup).</div>
                <button type="button" class="btn" id="emEditBtn2">Jetzt ausfüllen</button>`}
            </div>
            <div class="em-foot">Alle Infos funktionieren offline${c.ja || tr ? '' : ' (Sätze nach der ersten Übersetzung)'}. Angaben ohne Gewähr – im Zweifel ${c.ja ? '110 oder 119' : esc(firstNum)} wählen.</div>`;
        cont.querySelectorAll('.em-phrase').forEach(b => b.addEventListener('click', () => {
            haptic();
            if (b.dataset.allergy) showBig(allergyFor(null), true);
            else showBig(cur.sent[Number(b.dataset.idx)]);
        }));
        document.getElementById('emEditBtn')?.addEventListener('click', openEdit);
        document.getElementById('emEditBtn2')?.addEventListener('click', openEdit);
        document.getElementById('emShowCard')?.addEventListener('click', showCard);
    }

    // ── Großanzeige (Vollbild-Dialog) ─────────────────────────────────────────
    let bigDlg = null;
    function ensureBig() {
        if (bigDlg) return bigDlg;
        bigDlg = document.createElement('dialog');
        bigDlg.className = 'em-big';
        bigDlg.setAttribute('aria-label', 'Notfall-Satz groß');
        bigDlg.innerHTML = `
            <div class="em-big-body" id="emBigBody"></div>
            <div class="em-big-actions">
                <button type="button" class="btn btn-secondary" id="emBigSpeak">${ico('speaker-high', '🔊')} Vorlesen</button>
                <button type="button" class="btn" id="emBigClose">Schließen</button>
            </div>`;
        document.getElementById('app').appendChild(bigDlg);
        bigDlg.querySelector('#emBigClose').addEventListener('click', () => bigDlg.close());
        bigDlg.querySelector('#emBigSpeak').addEventListener('click', () => {
            const t = bigDlg.dataset.say || '';
            if (cur.ja || !t) speakJa(t);
            else if (typeof speakPhrase === 'function') speakPhrase(t);
        });
        bigDlg.addEventListener('click', e => { if (e.target === bigDlg) bigDlg.close(); });
        return bigDlg;
    }
    function showBig(s, withAllergens) {
        const dlg = ensureBig();
        const body = dlg.querySelector('#emBigBody');
        body.innerHTML = `
            <div class="em-big-jp" lang="${esc(ctx().lang)}">${esc(s[0])}</div>
            <div class="em-big-ro"${s[1] ? '' : ' hidden'}>${esc(s[1])}</div>
            <div class="em-big-de">${esc(s[2])}</div>
            ${withAllergens ? `<div class="em-allergens" role="group" aria-label="Auslöser wählen">${ALLERGENS.map((a, i) =>
                cur.ja ? `<button type="button" class="chip-sm em-allergen" data-i="${i}" lang="ja">${esc(a[0])} <span lang="de">${esc(a[2])}</span></button>`
                    : `<button type="button" class="chip-sm em-allergen" data-i="${i}">${esc(a[2])}</button>`).join('')}</div>` : ''}`;
        dlg.dataset.say = s[0];
        body.querySelectorAll('.em-allergen').forEach(b => b.addEventListener('click', () => {
            haptic();
            const t = allergyFor(Number(b.dataset.i));
            body.querySelector('.em-big-jp').textContent = t[0];
            body.querySelector('.em-big-ro').textContent = t[1];
            body.querySelector('.em-big-de').textContent = t[2];
            dlg.dataset.say = t[0];
            body.querySelectorAll('.em-allergen').forEach(x => x.classList.toggle('active', x === b));
        }));
        if (!dlg.open) dlg.showModal();
        dlg.querySelector('#emBigClose').focus({ preventScroll: true });
    }
    // Ausweis auf Japanisch für Ärzte/Helfer (japanische Labels, Werte wie eingegeben).
    function showCard() {
        const d = load(), dlg = ensureBig();
        const rows = FIELDS.filter(([k]) => d[k]).map(([k, label, ja, type]) => {
            const v = type === 'blood' && cur.ja ? `${BLOOD_JA[d[k]] || ''} (${d[k]})` : d[k];
            const native = cur.ja ? ja : cur.tr ? cur.tr[I_LABELS + FIELDS.findIndex(f => f[0] === k)] : '';
            return `<div class="em-id-row"><div class="em-id-label">${native && native !== label ? `<span lang="${esc(ctx().lang)}">${esc(native)}</span> · ` : ''}${esc(label)}</div><div class="em-id-val">${esc(v)}</div></div>`;
        }).join('');
        dlg.querySelector('#emBigBody').innerHTML = `
            <div class="em-id-head" lang="${esc(ctx().lang)}">${cur.ja ? '緊急時情報カード' : esc(cur.tr ? cur.tr[I_CARD] : 'Notfall-Ausweis')}</div>
            <div class="em-id-sub">Notfall-Ausweis · Emergency card</div>
            ${rows}`;
        dlg.dataset.say = '';
        if (!dlg.open) dlg.showModal();
        dlg.querySelector('#emBigClose').focus({ preventScroll: true });
    }
    function speakJa(text) {
        if (!text) { showToast('🔇 Für den Ausweis gibt es keine Vorlesefunktion.'); return; }
        try {
            if (!('speechSynthesis' in window)) { showToast('🔇 Vorlesen wird nicht unterstützt.'); return; }
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            u.lang = 'ja-JP';
            const v = window.speechSynthesis.getVoices().find(x => x.lang.toLowerCase().replace('_', '-').startsWith('ja'));
            if (v) u.voice = v; else showToast('🔇 Keine japanische Stimme installiert – Display zeigen.');
            window.speechSynthesis.speak(u);
        } catch (e) { showToast('🔇 Vorlesen fehlgeschlagen.'); }
    }

    // ── Bearbeiten-Dialog ─────────────────────────────────────────────────────
    let editDlg = null;
    function ensureEdit() {
        if (editDlg) return editDlg;
        editDlg = document.createElement('dialog');
        editDlg.id = 'modal-emergency';
        editDlg.setAttribute('aria-labelledby', 'modal-emergency-title');
        editDlg.innerHTML = `
            <h3 id="modal-emergency-title">Mein Notfall-Ausweis</h3>
            <div class="dialog-body">
                <p class="em-hint">Wird nur auf diesem Gerät gespeichert und ins Backup übernommen.</p>
                ${FIELDS.map(([k, label, , type, max, ph]) => {
                    const id = 'em-f-' + k;
                    if (type === 'blood') return `<div class="form-group"><label for="${id}">${esc(label)}</label><select id="${id}">${BLOOD.map(b => `<option value="${esc(b)}">${b ? esc(b) : 'unbekannt'}</option>`).join('')}</select></div>`;
                    if (type === 'area') return `<div class="form-group"><label for="${id}">${esc(label)}</label><textarea id="${id}" rows="2" maxlength="${max}" placeholder="${esc(ph)}"></textarea></div>`;
                    return `<div class="form-group"><label for="${id}">${esc(label)}</label><input id="${id}" type="${type === 'tel' ? 'tel' : 'text'}" maxlength="${max}" placeholder="${esc(ph)}"${type === 'tel' ? ' inputmode="tel" autocomplete="off"' : ''}></div>`;
                }).join('')}
            </div>
            <div class="dialog-actions">
                <button type="button" class="btn" id="emSave">Speichern</button>
                <button type="button" class="btn btn-secondary" id="emCancel">Abbrechen</button>
            </div>`;
        document.getElementById('app').appendChild(editDlg);
        editDlg.querySelector('#emCancel').addEventListener('click', () => editDlg.close());
        editDlg.querySelector('#emSave').addEventListener('click', save);
        const body = editDlg.querySelector('.dialog-body');
        const sync = () => body.classList.toggle('can-scroll', body.scrollHeight - body.scrollTop - body.clientHeight > 1);
        body.addEventListener('scroll', sync, { passive: true });
        if (window.ResizeObserver) new ResizeObserver(sync).observe(body);
        if (window.matchMedia?.('(pointer: coarse)').matches) { const h = editDlg.querySelector('h3'); h.tabIndex = -1; h.autofocus = true; }
        return editDlg;
    }
    function openEdit() {
        const dlg = ensureEdit(), d = load();
        FIELDS.forEach(([k]) => { const el = dlg.querySelector('#em-f-' + k); if (el) el.value = d[k]; });
        dlg.showModal();
    }
    function save() {
        const raw = {};
        FIELDS.forEach(([k]) => { raw[k] = editDlg.querySelector('#em-f-' + k)?.value ?? ''; });
        const d = normalize(raw);
        if (!writeJson(KEY, d)) return; // safeSetItem zeigt bereits den Speicher-Toast
        editDlg.close();
        haptic();
        showToast('✅ Notfall-Ausweis gespeichert');
        render();
    }

    // ── SOS-Schnellzugriff in der Kopfzeile (ersetzt den leeren Platzhalter rechts) ──
    function mountSos() {
        const spacer = document.querySelector('.app-header .header-spacer');
        if (!spacer || document.getElementById('sosBtn')) return;
        const b = document.createElement('button');
        b.type = 'button'; b.id = 'sosBtn'; b.className = 'header-btn sos-btn';
        b.setAttribute('aria-label', 'Notfall-Infos öffnen'); b.title = 'Notfall';
        b.textContent = 'SOS';
        b.addEventListener('click', () => switchView('view-emergency', 'Notfall'));
        spacer.replaceWith(b);
    }

    mountSos();
    window.emergency = { render, normalize };
    // Auf direkt wiederhergestellter Ansicht (restoreLastView) sicher gefüllt sein.
    document.addEventListener('DOMContentLoaded', render);
})();
