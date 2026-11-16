// ─── BUCHUNGEN AUS BESTÄTIGUNGEN LESEN ─────────────────────────────────────
// Wird eine Bestätigung an eine Unterkunft, Etappe, Anreise oder Rückreise angehängt, liest die
// App den Text aus: Hotelname bzw. Zug/Flug, Abfahrtszeit und Gleis/Sitz werden eingetragen.
// Der Text wird so gelesen:
//   PDF   -> Textebene (pdf.js, nur bei echten PDFs mit Text)
//   Foto  -> Texterkennung im Browser (Tesseract.js)
// Beide Bibliotheken werden erst beim ersten Bedarf geladen. Der gefundene Name wird
// vorgeschlagen bzw. eingetragen; die Erkennung ist eine Heuristik und kann danebenliegen,
// deshalb wird ein bereits eingetragener, abweichender Name nur nach Rückfrage ersetzt.
(function () {
    'use strict';
    const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    const MAX_LEN = 80;
    // Konkrete Unterkunftsarten für freie Zeilen. Allgemeine Wörter wie „Unterkunft“ oder „Accommodation“
    // stehen oft im Seitentitel („Unterkunft in Tokyo“) und zählen deshalb nur in beschrifteten Zeilen.
    const KEYWORD = /\b(hotel|ryokan|minshuku|inn|hostel|resort|guest ?house|guesthouse|apartment|lodge|villa|pension|gasthof)\b/i;
    const GENERIC_TITLE = /\b(unterkunft|accommodation|booking|buchung|reise|trip plan|in (tokyo|japan|kyoto|osaka))\b/i;
    const LABEL = /^\s*(hotel(\s*name)?|property( name)?|unterkunft|accommodation( name)?|name of (the )?(hotel|property))\s*[:：]\s*(.+)$/i;
    const NOISE = /(check[- ]?in|check[- ]?out|reservation|confirmation|booking|buchung|price|total|preis|guest|gast|room|zimmer|www\.|https?:|@|\d{2}[./-]\d{2})/i;

    // Ganz in Großbuchstaben geschriebene Wörter (ab 4 Buchstaben) normal schreiben: "HOTEL Tokyo" -> "Hotel Tokyo".
    // Kürzel wie "ANA" oder "APA" bleiben unverändert, gemischt geschriebene Wörter auch.
    const normCase = name => name.replace(/\b[A-ZÄÖÜ]{4,}\b/g, w => w.charAt(0) + w.slice(1).toLowerCase());
    // Reiner Text -> Hotelname oder ''. Zuerst Zeilen mit Beschriftung ("Hotel: X"), dann freie Zeilen mit Schlüsselwort.
    function extractHotelName(text) {
        const name = findName(text);
        return name ? normCase(name) : '';
    }
    function findName(text) {
        const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
        const clean = s => s.replace(/^[\s"'„“*•\-–:]+|[\s"'“”*•\-–:,.;]+$/g, '').slice(0, MAX_LEN).trim();
        for (const l of lines) {
            const m = LABEL.exec(l);
            if (m) { const v = clean(m[m.length - 1]); if (v && !NOISE.test(v) && v.length >= 3) return v; }
        }
        for (const l of lines) {
            if (!KEYWORD.test(l) || NOISE.test(l) || GENERIC_TITLE.test(l) || l.length > MAX_LEN + 20) continue;
            // Nur die Wortgruppe um das Schlüsselwort (z. B. "Hotel Gracery Tokyo")
            const v = clean(l.split(/\s{2,}|\|/)[0]);
            if (v.length >= 4 && KEYWORD.test(v) && !GENERIC_TITLE.test(v)) return v;
        }
        return '';
    }

    // ─── Zug und Flug ──────────────────────────────────────────────────────
    const TRAIN_NAMES = 'Nozomi|Hikari|Kodama|Sakura|Mizuho|Tsubame|Hayabusa|Komachi|Yamabiko|Nasuno|Kagayaki|Shinkansen|Limited Express|JR|ICE|TGV|Zug|Train';
    const TRAIN_RE = new RegExp(`\\b(${TRAIN_NAMES})\\b[\\s#:.-]*([A-Z]{0,3}\\s?\\d{1,4})`, 'i');
    const FLIGHT_RE = /\b([A-Z]{2}\s?\d{2,4})\b/;
    const FLIGHT_CTX = /(flug|flight|airline|abflug|departure|boarding)/i;
    const DEP_RE = /(abfahrt|abflug|departure|depart(s|ure)?)\D{0,20}(\d{1,2}[:.]\d{2})/i;
    const SEAT_RE = /\b(gleis|platform|gate|sitz|seat|wagen|car|terminal)\s*[:#]?\s*([A-Z0-9][A-Z0-9 ,\/-]{0,18})/gi;
    // Verbindung aus dem Text: { train, dep, seat } oder null. Heuristisch wie der Hotelname.
    function extractTransit(text) {
        const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
        let train = '';
        for (const l of lines) {
            const m = TRAIN_RE.exec(l);
            if (m) { train = (m[1] + ' ' + m[2]).replace(/\s+/g, ' ').trim(); break; }
        }
        if (!train) {
            for (const l of lines) {
                if (!FLIGHT_CTX.test(l)) continue;
                const m = FLIGHT_RE.exec(l);
                if (m) { train = m[1].replace(/^([A-Z]{2})\s?/, '$1 '); break; }
            }
        }
        let dep = '';
        for (const l of lines) {
            if (/(check[- ]?in|check[- ]?out|hotel|unterkunft)/i.test(l)) continue;
            const m = DEP_RE.exec(l);
            if (m) { const [h, mi] = m[3].replace('.', ':').split(':'); dep = `${h.padStart(2, '0')}:${mi}`; break; }
        }
        const seats = [];
        for (const l of lines) {
            SEAT_RE.lastIndex = 0;
            let m;
            while ((m = SEAT_RE.exec(l))) seats.push(`${m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()} ${m[2].trim().replace(/[ ,\/-]+$/, '')}`);
        }
        const seat = [...new Set(seats)].slice(0, 3).join(' · ').slice(0, 40);
        if (!train && !dep) return null;
        return { train: train.slice(0, 60), dep, seat, note: '' };
    }
    const sameTransit = (a, b) => !!a && !!b && a.train === b.train && a.dep === b.dep;

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src; s.async = true; s.crossOrigin = 'anonymous';
            s.onload = () => resolve(); s.onerror = () => reject(new Error('Bibliothek konnte nicht geladen werden'));
            document.head.appendChild(s);
        });
    }

    async function pdfText(blob) {
        if (!window.pdfjsLib) await loadScript(PDFJS);
        const lib = window.pdfjsLib;
        if (!lib) throw new Error('pdf.js nicht verfügbar');
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        let out = '';
        for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
            const content = await (await pdf.getPage(p)).getTextContent();
            let lastY = null;
            for (const it of content.items) {
                const y = it.transform ? Math.round(it.transform[5]) : null;
                out += (lastY !== null && y !== lastY ? '\n' : ' ') + it.str;
                lastY = y;
            }
            out += '\n';
        }
        return out;
    }
    async function imageText(blob) {
        if (!window.Tesseract) await loadScript(TESSERACT);
        if (!window.Tesseract) throw new Error('Texterkennung nicht verfügbar');
        const { data } = await window.Tesseract.recognize(blob, 'eng');
        return data && data.text ? data.text : '';
    }
    // Text einer gespeicherten Bestätigung (über die Dokumente-Schnittstelle)
    async function readDocument(docId) {
        const d = await window.documentsFeature?.sync?.get(docId);
        if (!d) return '';
        return d.kind === 'pdf' ? pdfText(d.blob) : imageText(d.blob);
    }

    // Nach dem Anhängen (und beim erneuten Lesen): Daten lesen und eintragen.
    // quiet: nichts melden, wenn nichts zu tun ist (für den automatischen Lauf beim Start).
    async function suggest(docId, ref, quiet = false) {
        const toast = (msg) => { if (!quiet) (typeof showResultToast === 'function' ? showResultToast(msg, 'ok') : showToast(msg)); };
        const hotel = /^hotel:(-?\d+(?:\.\d+)?)$/.exec(ref || '');
        const isTransit = ref === 'arrival' || ref === 'return' || /^leg:-?\d+(\.\d+)?$/.test(ref || '');
        if (!hotel && !isTransit) return true;
        if (typeof places === 'undefined') return true;
        toast(hotel ? 'Lese Hotelnamen aus der Bestätigung …' : 'Lese Verbindung aus der Bestätigung …');
        let text = '';
        try { text = await readDocument(docId); }
        catch (e) { console.warn('Buchung lesen:', e); toast('Bestätigung konnte nicht gelesen werden – bitte selbst eintragen'); return false; }
        return hotel ? applyHotel(Number(hotel[1]), text, toast) : applyTransit(ref, text, toast);
    }
    async function applyHotel(pid, text, toast) {
        const name = extractHotelName(text);
        const p = places.find(x => Number(x.id) === pid);
        if (!p) return true;
        if (!name) { toast('Keinen Hotelnamen gefunden – bitte selbst eintragen'); return true; }
        if (p.hotel === name) { toast(`Hotel „${name}“ ist schon eingetragen`); return true; }
        if (!p.hotel) { toast(`Hotel „${name}“ eingetragen`); await saveHotel(pid, name); return true; }
        if (confirm(`Aus der Bestätigung gelesen: „${name}“.\n\nStatt „${p.hotel}“ in der Station eintragen?`)) {
            toast(`Hotel „${name}“ eingetragen`);
            await saveHotel(pid, name);
        }
        return true;
    }
    // Zielfeld der Verbindung: Anreise = Station 1, Rückreise = reiseweit, Etappe = Zielstation.
    function transitSlot(ref) {
        if (ref === 'arrival') return { get: () => places[0]?.transit || null, set: v => { if (places[0]) places[0].transit = v; } };
        if (ref === 'return') return { get: () => window.tripBooking?.return || null, set: v => { window.tripBooking.return = v; } };
        const p = places.find(x => Number(x.id) === Number(ref.slice(4)));
        return p ? { get: () => p.transit || null, set: v => { p.transit = v; } } : null;
    }
    async function applyTransit(ref, text, toast) {
        const info = extractTransit(text);
        const slot = transitSlot(ref);
        if (!slot) return true;
        if (!info) { toast('Keine Zug- oder Flugdaten gefunden – bitte selbst eintragen'); return true; }
        const cur = slot.get();
        const value = normTransit(Object.assign({ note: cur?.note || '' }, info, { seat: info.seat || cur?.seat || '' }));
        if (cur && !sameTransit(cur, value)) {
            const old = [cur.train, cur.dep].filter(Boolean).join(' · ') || 'leer';
            const next = [value.train, value.dep].filter(Boolean).join(' · ');
            if (!confirm(`Aus der Bestätigung gelesen: „${next}“.\n\nStatt „${old}“ eintragen?`)) return true;
        }
        slot.set(value);
        saveData();
        toast(`Verbindung eingetragen: ${[value.train, value.dep].filter(Boolean).join(' · ')}`);
        return true;
    }
    // Eine Bestätigung neu lesen (Aktualisieren-Teil der Pille); ohne docId alle Bestätigungen der Unterkunft.
    async function scanRef(ref, docId) {
        const docs = (window.documentsFeature?.byRef?.(ref) || []).filter(d => !docId || d.id === docId);
        if (!docs.length) return;
        if (typeof showResultToast === 'function') showResultToast('Lese Bestätigung erneut …', 'ok');
        for (const d of docs) await suggest(d.id, ref, false);
    }
    // Einmalig nach dem Update: alle schon vorhandenen Bestätigungen auslesen.
    // Erledigte IDs stehen in tp_booking_scanned; gelesen wird nur, was dort noch fehlt.
    const SCANNED_KEY = 'tp_booking_scanned';
    function scannedIds() { try { return new Set(JSON.parse(localStorage.getItem(SCANNED_KEY) || '[]')); } catch (e) { return new Set(); } }
    async function scanExisting() {
        const api = window.documentsFeature?.sync;
        if (!api || typeof places === 'undefined' || !places.length) return;
        const done = scannedIds();
        const all = (await api.all()).filter(d => /^(hotel:|leg:|arrival$|return$)/.test(d.ref || '') && !done.has(d.id));
        for (const d of all) {
            const ok = await suggest(d.id, d.ref, true);
            if (ok) { done.add(d.id); try { localStorage.setItem(SCANNED_KEY, JSON.stringify([...done])); } catch (e) {} }
        }
    }
    // Nach dem Start, wenn Reisedaten und Dokumente geladen sind. Ohne Netz einfach später erneut.
    if (typeof window.document !== 'undefined' && typeof setTimeout === 'function')
        setTimeout(() => { scanExisting().catch(e => console.warn('Bestätigungen nachlesen:', e)); }, 4000);

    window.bookingRead = { extractHotelName, extractTransit, suggest, scanRef };
})();
