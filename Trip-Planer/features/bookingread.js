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
    const FLIGHT_CODE_RE = /\b([A-Z]{2})\s?(\d{2,4})\b/;
    // Buchungsportale (Expedia, Check24 …) schreiben oft den Namen der Fluglinie statt des Kürzels:
    // "Jetstar Japan 513" -> "GK 513". Längere Namen zuerst, damit "Japan Airlines" vor "Japan" greift.
    const AIRLINES = [
        ['Jetstar Japan', 'GK'], ['Japan Airlines', 'JL'], ['JAL', 'JL'], ['All Nippon Airways', 'NH'], ['ANA', 'NH'],
        ['Peach Aviation', 'MM'], ['Peach', 'MM'], ['Skymark', 'BC'], ['Spring Japan', 'IJ'], ['Zipair', 'ZG'],
        ['StarFlyer', '7G'], ['Solaseed Air', '6J'], ['Air Do', 'HD'], ['Fuji Dream Airlines', 'JH'], ['Jetstar', 'JQ'],
        ['Lufthansa', 'LH'], ['Eurowings', 'EW'], ['Condor', 'DE'], ['Austrian', 'OS'], ['Swiss', 'LX'], ['KLM', 'KL'],
        ['Air France', 'AF'], ['British Airways', 'BA'], ['Finnair', 'AY'], ['Turkish Airlines', 'TK'], ['Emirates', 'EK'],
        ['Qatar Airways', 'QR'], ['Etihad', 'EY'], ['Korean Air', 'KE'], ['Asiana', 'OZ'], ['Cathay Pacific', 'CX'],
        ['Singapore Airlines', 'SQ'], ['Thai Airways', 'TG'], ['EVA Air', 'BR'], ['China Airlines', 'CI'],
        ['Ryanair', 'FR'], ['easyJet', 'U2'], ['Wizz Air', 'W6'], ['United', 'UA'], ['Delta', 'DL'], ['American Airlines', 'AA']
    ].sort((a, b) => b[0].length - a[0].length);
    const AIRLINE_RE = new RegExp(`\\b(${AIRLINES.map(a => a[0].replace(/ /g, '\\s+')).join('|')})\\s*(?:flug|flight|nr\\.?|no\\.?|#)?\\s*(\\d{2,4})\\b`, 'i');
    const airlineCode = name => (AIRLINES.find(a => a[0].toLowerCase() === name.replace(/\s+/g, ' ').toLowerCase()) || [])[1] || '';
    // Unbekannte Fluglinie, aber erkennbar am Namen ("Sunrise Airways 120"): Name und Nummer übernehmen.
    const AIRLINE_NAME_RE = /\b((?:[A-Z][\w&-]*\s+){0,3}[A-Z]?[\w&-]*(?:air|airlines?|airways|aviation|jet)\b)\s+(\d{2,4})\b/i;
    const DEP_LABEL_RE = /\b(abflug|abfahrt|departure|depart)\b/i;
    const ARR_LINE_RE = /^\s*(ankunft|arrival|arrive|landung)\b/i;
    // Uhrzeit mit OCR-Toleranz: "1O:40" (O statt 0), "10.40", "10;40"
    const TIME = '([0-9O]{1,2}[:.;,][0-9O]{2})';
    const AIRPORT_TIME_RE = new RegExp(`\\b([A-Z]{3})\\b[^\\d\\n]{0,25}${TIME}\\b`);
    const LABEL_RE = /\b(terminal|gate|seat|sitz|gleis|platform|wagen|car|haltestelle)\b\s*[:#]?\s*([^\s]*)/gi;
    const normTime = t => { const [h, m] = t.replace(/O/g, '0').split(/[:.;,]/); return `${h.padStart(2, '0')}:${m}`; };
    const FLIGHT_CTX = /(flug|flight|airline|abflug|departure|boarding)/i;
    const DEP_RE = /(abfahrt|abflug|departure|depart(s|ure)?)\D{0,20}(\d{1,2}[:.]\d{2})/i;
    const SEAT_RE = /\b(gleis|platform|gate|sitz|seat|wagen|car|terminal)\s*[:#]?\s*([A-Z0-9][A-Z0-9 ,\/-]{0,18})/gi;
    // Verbindung aus dem Text: { train, dep, seat } oder null. Heuristisch wie der Hotelname.
    // Tabellen-Layout aus App-Screenshots: eine Zeile nur mit Beschriftungen ("Terminal Gate Boarding time"),
    // darunter die Werte in gleicher Reihenfolge ("2 - -"). Liefert zusätzliche Zeilen "Terminal 2".
    const HEADER_RE = /\b(boarding time|terminal|gate|boarding|class|klasse|seat|sitz|gleis|platform)\b/gi;
    function tableLines(lines) {
        const out = [];
        lines.forEach((l, i) => {
            const labels = l.match(HEADER_RE) || [];
            if (labels.length < 2 || /[a-z0-9]/i.test(l.replace(HEADER_RE, '')) || !lines[i + 1]) return;
            const vals = lines[i + 1].split(' ').filter(t => !/^[>|<»›]+$/.test(t));
            labels.forEach((lab, k) => {
                const v = vals.length === labels.length ? vals[k] : k === 0 ? vals[0] : k === labels.length - 1 ? vals[vals.length - 1] : '';
                if (v) out.push(`${lab} ${v}`);
            });
        });
        return out;
    }
    // Texterkennung mit Wortpositionen: zu jeder Beschriftung das Wort direkt darunter suchen ("Seat" über "18K").
    function labelLinesFromWords(words) {
        const out = [];
        for (const w of words || []) {
            if (!w || !w.bbox || !/^(terminal|gate|seat|sitz|gleis|platform)$/i.test(w.text || '')) continue;
            const h = w.bbox.y1 - w.bbox.y0, cx = (w.bbox.x0 + w.bbox.x1) / 2;
            let best = null;
            for (const v of words) {
                if (v === w || !v.bbox) continue;
                const dy = v.bbox.y0 - w.bbox.y1;
                if (dy < -h * 0.3 || dy > h * 3.5) continue;
                const dx = Math.abs((v.bbox.x0 + v.bbox.x1) / 2 - cx);
                if (dx > Math.max(w.bbox.x1 - w.bbox.x0, v.bbox.x1 - v.bbox.x0)) continue;
                if (!best || dy < best.dy) best = { dy, text: v.text };
            }
            if (best) out.push(`${w.text} ${best.text}`);
        }
        return out;
    }
    function extractTransit(text) {
        const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
        lines.push(...tableLines(lines));
        let train = '';
        for (const l of lines) {
            const m = TRAIN_RE.exec(l);
            if (m) { train = (m[1] + ' ' + m[2]).replace(/\s+/g, ' ').trim(); break; }
        }
        // Fluglinie ausgeschrieben ("Jetstar Japan 513")
        if (!train) {
            for (const l of lines) {
                const m = AIRLINE_RE.exec(l);
                if (m) { train = airlineCode(m[1]) + ' ' + m[2]; break; }
            }
        }
        // Flugnummer: zuerst in Zeilen mit Flug-Wort, sonst irgendwo (Screenshots haben oft nur "JL407" in einer Zeile)
        if (!train) {
            const ordered = [...lines.filter(l => FLIGHT_CTX.test(l)), ...lines];
            for (const l of ordered) {
                const m = FLIGHT_CODE_RE.exec(l);
                if (m) { train = m[1] + ' ' + m[2]; break; }
            }
        }
        const hm = normTime;
        let dep = '';
        for (const l of lines) {
            if (/(check[- ]?in|check[- ]?out|hotel|unterkunft)/i.test(l)) continue;
            const m = DEP_RE.exec(l);
            if (m) { dep = hm(m[3].replace(/O/g, '0')); break; }
        }
        // Uhrzeit über bzw. neben der Beschriftung ("15:25 Uhr" / "Abflug: Sa., 28. Nov."): Expedia u. a.
        // Bei zwei Spalten in einer Zeile ("15:25 uhr 17:55 uhr") ist die erste Zeit der Abflug.
        if (!dep) {
            const i = lines.findIndex(l => DEP_LABEL_RE.test(l) && !/(check[- ]?in|check[- ]?out)/i.test(l));
            if (i >= 0) {
                for (const l of [lines[i], lines[i - 1], lines[i - 2]].filter(Boolean)) {
                    const m = new RegExp(`(?:^|[^\\d])${TIME}(?!\\d)`).exec(l);
                    if (m) { dep = hm(m[1]); break; }
                }
            }
        }
        // Ohne Beschriftung: Flughafen-Kürzel mit Uhrzeit ("NRT 10:40") ist der Abflug, wenn es eine Flugnummer gibt
        if (!dep && train && /^[A-Z]{2} \d/.test(train)) {
            // Flughafen und Zeit können in getrennten Zeilen stehen: einzelne Zeile und Zeilenpaare prüfen
            const cand = lines.flatMap((l, i) => [l, i + 1 < lines.length ? l + ' ' + lines[i + 1] : '']);
            for (const l of cand) {
                const m = AIRPORT_TIME_RE.exec(l);
                if (m) { dep = hm(m[2]); break; }
            }
        }
        // Fluglinie nur am Namen erkennbar
        if (!train) {
            for (const l of lines) {
                const m = AIRLINE_NAME_RE.exec(l);
                if (m && !/(reiseplan|itinerary|bestätigung|confirmation)/i.test(l)) { train = (m[1] + ' ' + m[2]).replace(/\s+/g, ' ').trim(); break; }
            }
        }
        // Letzter Ausweg bei erkanntem Flug: erste Uhrzeit im Text, die nicht zu Hotel oder Check-in gehört
        if (!dep && train) {
            // Erst ab der Zeile mit der Flug-/Zugnummer suchen: davor steht oft die Uhr der Statusleiste
            const from = Math.max(0, lines.findIndex(l => FLIGHT_CODE_RE.test(l) || TRAIN_RE.test(l)));
            for (const l of lines.slice(from)) {
                if (/(check[- ]?in|check[- ]?out|hotel|unterkunft|uhr\s*\(|ortszeit|stornier)/i.test(l)) continue;
                const m = new RegExp(`\\b${TIME}\\b`).exec(l);
                if (m) { dep = hm(m[1]); break; }
            }
        }
        // Beschriftung und Wert: "Terminal 2", "Gate 23", "Seat 18K" – oder der Wert steht in der nächsten Zeile
        const parts = { terminal: '', gate: '', seat: [] };
        const valueOk = v => /\d/.test(v) && v.length <= 8;
        // Terminal/Gate der Ankunft gehören nicht zur Abfahrt: Zeilen ab "Ankunft …" bis zum nächsten
        // "Abflug …" überspringen; stehen beide Spalten in einer Zeile ("Terminal 3 Terminal D, Gate 1"),
        // nur bis zur zweiten Beschriftung lesen.
        let arrival = false;
        lines.forEach((l, i) => {
            if (ARR_LINE_RE.test(l)) arrival = true;
            else if (/^\s*(abflug|abfahrt|departure|depart)\b/i.test(l)) arrival = false;
            if (arrival) return;
            const twice = l.search(/\bterminal\b.*?\bterminal\b/i) >= 0 ? l.slice(0, l.toLowerCase().indexOf('terminal', l.toLowerCase().indexOf('terminal') + 8)) : null;
            if (twice !== null) l = twice;
            LABEL_RE.lastIndex = 0;
            let m;
            while ((m = LABEL_RE.exec(l))) {
                let v = m[2].replace(/[.,;|>]+$/, '');
                if (!v && lines[i + 1] && !/^[A-Za-z]{3,}/.test(lines[i + 1])) v = lines[i + 1].split(' ')[0].replace(/[.,;|>]+$/, '');
                // Häufige OCR-Verwechslungen: I/l statt 1, O statt 0 (z. B. "I8K" -> "18K", "1O" -> "10")
                v = v.replace(/^[Il|](?=\d|[A-K]$)/, '1').replace(/O/g, '0').replace(/^(\d+)[lI]$/, '$11');
                if (!valueOk(v)) continue;
                const label = m[1].toLowerCase();
                if (label === 'terminal') { if (!parts.terminal) parts.terminal = v; }
                else if (label === 'gate' || label === 'gleis' || label === 'platform') { if (!parts.gate) parts.gate = v; }
                else if (label === 'wagen' || label === 'car') parts.seat.push(`Wagen ${v}`);
                else parts.seat.push(v);
            }
        });
        const seat = [...new Set(parts.seat)].slice(0, 3).join(' · ').slice(0, 40);
        const terminal = parts.terminal.slice(0, 20), gate = parts.gate.slice(0, 20);
        if (!train && !dep) return null;
        return { train: train.slice(0, 60), dep, terminal, gate, seat, note: '' };
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

    // pdf.js bei Bedarf laden (auch für die PDF-Anzeige in features/documents.js)
    async function loadPdfJs() {
        if (!window.pdfjsLib) await loadScript(PDFJS);
        const lib = window.pdfjsLib;
        if (!lib) throw new Error('pdf.js nicht verfügbar');
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        return lib;
    }
    async function pdfText(blob) {
        const lib = await loadPdfJs();
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
        if (!data) return '';
        // Wortpositionen nutzen, damit Werte unter ihrer Beschriftung gefunden werden (Spalten-Layout)
        let extra = [];
        try { extra = labelLinesFromWords(data.words); } catch (e) {}
        return (data.text || '') + '\n' + extra.join('\n');
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
        if (!String(text).trim()) { toast('Kein Text in der Bestätigung erkannt – bitte als PDF oder schärferes Foto anhängen'); return true; }
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
        const value = normTransit({ note: cur?.note || '', train: info.train, dep: info.dep,
            terminal: info.terminal || cur?.terminal || '', gate: info.gate || cur?.gate || '', seat: info.seat || cur?.seat || '' });
        if (cur && !sameTransit(cur, value)) {
            const old = [cur.train, cur.dep].filter(Boolean).join(' · ') || 'leer';
            const next = [value.train, value.dep].filter(Boolean).join(' · ');
            if (!confirm(`Aus der Bestätigung gelesen: „${next}“.\n\nStatt „${old}“ eintragen?`)) return true;
        }
        slot.set(value);
        saveData();
        const found = [value.train, value.dep && `Abfahrt ${value.dep}`, value.terminal && `Terminal ${value.terminal}`,
            value.gate && `Gate ${value.gate}`, value.seat && `Sitz ${value.seat}`].filter(Boolean).join(' · ');
        const missing = [!value.dep && 'Abfahrt', !value.terminal && !value.gate && !value.seat && 'Terminal/Gate/Sitz'].filter(Boolean);
        toast(`Gelesen: ${found}${missing.length ? ` – nicht gefunden: ${missing.join(', ')} (bitte eintragen)` : ''}`);
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
    const SCANNED_KEY = 'tp_booking_scanned', RESCAN_KEY = 'tp_booking_rescan_v2';
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
        // Erkennung verbessert (Fluglinie ausgeschrieben, Expedia-Layout): Bestätigungen von Verbindungen,
        // die noch leer sind, einmalig erneut lesen. Belegte Verbindungen bleiben unberührt (keine Rückfrage).
        let again; try { again = new Set(JSON.parse(localStorage.getItem(RESCAN_KEY) || '[]')); } catch (e) { again = new Set(); }
        const empty = (await api.all()).filter(d => /^(leg:|arrival$|return$)/.test(d.ref || '') && !again.has(d.id)
            && !(transitSlot(d.ref)?.get()?.train));
        for (const d of empty) {
            if (transitSlot(d.ref)?.get()?.train) continue; // inzwischen von einer anderen Bestätigung gefüllt
            const ok = await suggest(d.id, d.ref, true);
            if (ok) { again.add(d.id); try { localStorage.setItem(RESCAN_KEY, JSON.stringify([...again])); } catch (e) {} }
        }
    }
    // Nach dem Start, wenn Reisedaten und Dokumente geladen sind. Ohne Netz einfach später erneut.
    if (typeof window.document !== 'undefined' && typeof setTimeout === 'function')
        setTimeout(() => { scanExisting().catch(e => console.warn('Bestätigungen nachlesen:', e)); }, 4000);

    window.bookingRead = { extractHotelName, extractTransit, labelLinesFromWords, suggest, scanRef, loadPdfJs };
})();
