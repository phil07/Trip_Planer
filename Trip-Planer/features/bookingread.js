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
    // Flughäfen mit Kürzel → lesbarer Name. Wichtig bei Städten mit mehreren Flughäfen
    // (Tokyo Narita/Haneda, Osaka Kansai/Itami, Frankfurt/Hahn, Berlin, London …).
    const AIRPORTS = {
        NRT: 'Tokyo Narita', HND: 'Tokyo Haneda', KIX: 'Osaka Kansai', ITM: 'Osaka Itami', UKB: 'Kobe', NGO: 'Nagoya Chubu',
        NKM: 'Nagoya Komaki', FUK: 'Fukuoka', CTS: 'Sapporo New Chitose', OKD: 'Sapporo Okadama', OKA: 'Okinawa Naha',
        HIJ: 'Hiroshima', KOJ: 'Kagoshima', KMJ: 'Kumamoto', SDJ: 'Sendai', KMQ: 'Komatsu', TAK: 'Takamatsu', MYJ: 'Matsuyama',
        NGS: 'Nagasaki', OIT: 'Oita', KKJ: 'Kitakyushu', HKD: 'Hakodate', ISG: 'Ishigaki', AOJ: 'Aomori', AXT: 'Akita',
        FRA: 'Frankfurt am Main', HHN: 'Frankfurt-Hahn', MUC: 'München', BER: 'Berlin Brandenburg', DUS: 'Düsseldorf',
        HAM: 'Hamburg', STR: 'Stuttgart', CGN: 'Köln/Bonn', NUE: 'Nürnberg', HAJ: 'Hannover', LEJ: 'Leipzig/Halle',
        DRS: 'Dresden', BRE: 'Bremen', FMM: 'Memmingen', NRN: 'Weeze', DTM: 'Dortmund', FKB: 'Karlsruhe/Baden-Baden',
        VIE: 'Wien', ZRH: 'Zürich', GVA: 'Genf', BSL: 'Basel', AMS: 'Amsterdam', CDG: 'Paris Charles de Gaulle', ORY: 'Paris Orly',
        BVA: 'Paris Beauvais', LHR: 'London Heathrow', LGW: 'London Gatwick', STN: 'London Stansted', LTN: 'London Luton',
        IST: 'Istanbul', SAW: 'Istanbul Sabiha Gökçen', DXB: 'Dubai', DOH: 'Doha', AUH: 'Abu Dhabi', HEL: 'Helsinki',
        CPH: 'Kopenhagen', WAW: 'Warschau', PRG: 'Prag', MAD: 'Madrid', BCN: 'Barcelona', FCO: 'Rom Fiumicino', CIA: 'Rom Ciampino',
        MXP: 'Mailand Malpensa', LIN: 'Mailand Linate', BGY: 'Mailand Bergamo', ICN: 'Seoul Incheon', GMP: 'Seoul Gimpo',
        PUS: 'Busan', TPE: 'Taipeh Taoyuan', TSA: 'Taipeh Songshan', HKG: 'Hongkong', SIN: 'Singapur', BKK: 'Bangkok Suvarnabhumi',
        DMK: 'Bangkok Don Mueang', PVG: 'Shanghai Pudong', SHA: 'Shanghai Hongqiao', PEK: 'Peking Capital', PKX: 'Peking Daxing',
        JFK: 'New York JFK', EWR: 'New York Newark', LGA: 'New York LaGuardia', LAX: 'Los Angeles', SFO: 'San Francisco', HNL: 'Honolulu'
    };
    // "NRT" → "Tokyo Narita (NRT)"; unbekannte Kürzel bleiben, wie sie sind.
    const airportLabel = code => { const c = String(code || '').trim().toUpperCase(); return AIRPORTS[c] ? `${AIRPORTS[c]} (${c})` : c; };
    // Abflughafen: erstes Kürzel in Klammern ("Tokyo, Japan (NRT-Narita Intl.)", "Frankfurt (FRA) - Tokio (HND)"),
    // sonst das erste bekannte Kürzel ("NRT" in einer eigenen Zeile).
    function departureAirport(lines) {
        for (const l of lines) {
            if (ARR_LINE_RE.test(l)) continue;
            const m = /\(([A-Z]{3})(?=[\s)\-–,])/.exec(l);
            if (m) return m[1];
        }
        for (const l of lines) {
            if (ARR_LINE_RE.test(l)) continue;
            const m = l.match(/\b[A-Z]{3}\b/g);
            const hit = m && m.find(c => AIRPORTS[c]);
            if (hit) return hit;
        }
        return '';
    }
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
        // Ankunft: zweite Zeit in der Zeile über "Abflug … Ankunft …" bzw. Zeit über/neben "Ankunft"
        let arr = '';
        {
            const T = new RegExp(`(?:^|[^\\d])${TIME}(?!\\d)`, 'g');
            const times = l => [...l.matchAll(T)].map(m => m[1]);
            const ai = lines.findIndex(l => /\b(ankunft|arrival|arrives?|landung)\b/i.test(l));
            if (ai >= 0) {
                const sameLineDep = DEP_LABEL_RE.test(lines[ai]);
                const own = times(lines[ai]).filter(x => !/[.,]/.test(x) || /[:]/.test(x));
                if (own.length && !sameLineDep) arr = hm(own[0]);
                else if (own.length >= 2) arr = hm(own[1]);
                else {
                    for (const l of [lines[ai - 1], lines[ai - 2]].filter(Boolean)) {
                        const ts = times(l);
                        if (sameLineDep && ts.length >= 2) { arr = hm(ts[1]); break; }
                        if (!sameLineDep && ts.length) { arr = hm(ts[ts.length - 1]); break; }
                    }
                }
            }
            if (arr && arr === dep) arr = '';
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
        const from = /^[A-Z0-9]{2} \d/.test(train) ? departureAirport(lines) : '';
        return { train: train.slice(0, 60), dep, arr, from, terminal, gate, seat, note: '' };
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
    // ─── Bordkarten-Barcode (IATA BCBP) ─────────────────────────────────────
    // Bordkarten tragen einen genormten Barcode (PDF417/Aztec/QR): "M1NAME/VORNAME  EPNR123 NRTFUKGK 0513 332Y012A0045 100".
    // Er enthält Flugnummer, Strecke, Tag im Jahr und Sitz – ohne Raten. Die Abflugzeit steht nicht darin.
    const BCBP_RE = /^M[1-4](.{20})[ A-Z](.{7})([A-Z]{3})([A-Z]{3})([A-Z0-9 ]{3})([0-9 ]{4}[A-Z ]?)(\d{3})([A-Z ])([0-9A-Z ]{4})/;
    function parseBCBP(raw, now = new Date()) {
        const m = BCBP_RE.exec(String(raw || ''));
        if (!m) return null;
        const carrier = m[5].trim(), fl = /^0*(\d{1,4})([A-Z]?)/.exec(m[6].trim());
        if (!/^[A-Z0-9]{2,3}$/.test(carrier) || !fl) return null;
        // Sitz "012A" -> "12A"; "INF"/Leer = kein Sitz
        const seatM = /^0*(\d{1,3}[A-Z])$/.exec(m[9].trim());
        // Tag im Jahr -> Datum: das nächste passende Datum ab ca. einem Monat vor heute
        let date = '';
        const doy = Number(m[7]);
        if (doy >= 1 && doy <= 366) {
            for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
                const d = new Date(Date.UTC(y, 0, doy));
                if (d.getTime() >= now.getTime() - 30 * 864e5) { date = d.toISOString().slice(0, 10); break; }
            }
        }
        return { train: `${carrier} ${fl[1]}${fl[2]}`, seat: seatM ? seatM[1] : '', from: m[3], to: m[4], date };
    }
    const BARCODE_FORMATS = ['pdf417', 'aztec', 'qr_code', 'data_matrix'];
    const ZXING = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
    async function decodeBarcodes(canvas) {
        // 1) Eingebaute Erkennung des Browsers (Chrome/Android), 2) sonst ZXing bei Bedarf laden
        try {
            if ('BarcodeDetector' in window) {
                const supported = await window.BarcodeDetector.getSupportedFormats();
                const formats = BARCODE_FORMATS.filter(f => supported.includes(f));
                if (formats.length === BARCODE_FORMATS.length || formats.includes('pdf417') && formats.includes('aztec')) {
                    const found = await new window.BarcodeDetector({ formats }).detect(canvas);
                    return found.map(b => b.rawValue).filter(Boolean);
                }
            }
        } catch (e) { /* weiter mit ZXing */ }
        try {
            if (!window.ZXing) await loadScript(ZXING);
            const Z = window.ZXing;
            if (!Z) return [];
            const hints = new Map();
            hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.PDF_417, Z.BarcodeFormat.AZTEC, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX]);
            hints.set(Z.DecodeHintType.TRY_HARDER, true);
            const reader = new Z.MultiFormatReader();
            reader.setHints(hints);
            const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(fitCanvas(canvas, 2000))));
            const r = reader.decode(bmp);
            return r && r.getText() ? [r.getText()] : [];
        } catch (e) { return []; } // kein Barcode gefunden (NotFoundException) oder Bibliothek nicht ladbar
    }

    // ─── Bilder vorbereiten ────────────────────────────────────────────────
    async function blobToCanvas(blob) {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close?.();
        return c;
    }
    function fitCanvas(src, maxSide) {
        const k = Math.min(1, maxSide / Math.max(src.width, src.height));
        if (k === 1) return src;
        const c = document.createElement('canvas');
        c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        return c;
    }
    // Für die Texterkennung: Statusleiste bei Handy-Screenshots abschneiden (sonst wird deren Uhrzeit
    // zur "Abfahrt"), kleine Bilder vergrößern, Graustufen, dunkle Screenshots invertieren, Kontrast strecken.
    function prepareForOcr(src) {
        const top = src.height > src.width * 1.6 ? Math.round(src.height * 0.035) : 0;
        const h0 = src.height - top;
        let k = Math.max(1, 1600 / src.width);
        k = Math.min(k, 2400 / src.width, Math.sqrt(9e6 / (src.width * h0)));
        const c = document.createElement('canvas');
        c.width = Math.round(src.width * k); c.height = Math.round(h0 * k);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, 0, top, src.width, h0, 0, 0, c.width, c.height);
        const img = g.getImageData(0, 0, c.width, c.height), px = img.data, n = px.length / 4;
        const hist = new Uint32Array(256);
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) {
            const v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0;
            px[i] = v; sum += v; hist[v]++;
        }
        const invert = sum / n < 110;
        let lo = 0, hi = 255, acc = 0;
        for (; lo < 255 && (acc += hist[lo]) < n * 0.02; lo++);
        acc = 0;
        for (; hi > 0 && (acc += hist[hi]) < n * 0.02; hi--);
        const span = Math.max(1, hi - lo);
        for (let i = 0; i < px.length; i += 4) {
            let v = Math.max(0, Math.min(255, (px[i] - lo) * 255 / span));
            if (invert) v = 255 - v;
            px[i] = px[i + 1] = px[i + 2] = v;
        }
        g.putImageData(img, 0, 0);
        return c;
    }

    async function ocr(canvasOrBlob) {
        if (!window.Tesseract) await loadScript(TESSERACT);
        if (!window.Tesseract) throw new Error('Texterkennung nicht verfügbar');
        let res;
        // Englisch + Deutsch (Umlaute, "Abflug", "Gleis"); falls das deutsche Paket nicht lädt, nur Englisch
        try { res = await window.Tesseract.recognize(canvasOrBlob, 'eng+deu'); }
        catch (e) { res = await window.Tesseract.recognize(canvasOrBlob, 'eng'); }
        const data = res && res.data;
        if (!data) return '';
        // Wortpositionen nutzen, damit Werte unter ihrer Beschriftung gefunden werden (Spalten-Layout)
        let extra = [];
        try { extra = labelLinesFromWords(data.words); } catch (e) {}
        return (data.text || '') + '\n' + extra.join('\n');
    }
    async function pdfRead(blob, wantCodes) {
        const lib = await loadPdfJs();
        const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        let text = '';
        for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
            const content = await (await pdf.getPage(p)).getTextContent();
            let lastY = null;
            for (const it of content.items) {
                const y = it.transform ? Math.round(it.transform[5]) : null;
                text += (lastY !== null && y !== lastY ? '\n' : ' ') + it.str;
                lastY = y;
            }
            text += '\n';
        }
        // Seite 1 als Bild: für den Barcode und für gescannte PDFs ohne Textebene
        const noText = text.replace(/\s+/g, '').length < 20;
        let codes = [];
        if (wantCodes || noText) {
            const page = await pdf.getPage(1);
            const vp = page.getViewport({ scale: 2 });
            const c = document.createElement('canvas');
            c.width = Math.round(vp.width); c.height = Math.round(vp.height);
            await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
            if (wantCodes) codes = await decodeBarcodes(c);
            if (noText) text = await ocr(prepareForOcr(c));
        }
        return { text, codes };
    }
    async function imageRead(blob, wantCodes) {
        let canvas = null;
        try { canvas = await blobToCanvas(blob); } catch (e) { /* altes Gerät: direkt lesen */ }
        if (!canvas) return { text: await ocr(blob), codes: [] };
        const codes = wantCodes ? await decodeBarcodes(canvas) : [];
        let text;
        try { text = await ocr(prepareForOcr(canvas)); } catch (e) { if (/nicht verfügbar|geladen/.test(e.message)) throw e; text = await ocr(canvas); }
        return { text, codes };
    }
    // Text (und Barcodes) einer gespeicherten Bestätigung (über die Dokumente-Schnittstelle)
    async function readDocument(docId, wantCodes) {
        const d = await window.documentsFeature?.sync?.get(docId);
        if (!d) return { text: '', codes: [] };
        return d.kind === 'pdf' ? pdfRead(d.blob, wantCodes) : imageRead(d.blob, wantCodes);
    }

    // ─── KI-Ergänzung über den eigenen Worker ──────────────────────────────
    // Nur wenn die Regeln Felder nicht finden. Vorher werden E-Mail, Telefonnummern und
    // beschriftete Namen entfernt; der Worker speichert nichts.
    const API_BASE = window.Capacitor?.isNativePlatform?.() ? 'https://japan.iphilipp07-869.workers.dev' : '';
    function redact(text) {
        return String(text || '')
            .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[E-Mail]')
            .replace(/(\+|\b00)\d[\d ()\/-]{7,}\d/g, '[Telefon]')
            .replace(/^.*\b(e-?mail|telefon|phone|tel\.?|mobil|passagier|passenger|reisende[rn]?|traveller|traveler|gast|guest name|name)\b\s*[:：].*$/gim, '')
            .replace(/^M[1-4].{20}/gm, '') // Barcode-Inhalt beginnt mit dem Namen
            .replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
    }
    async function aiExtract(kind, text) {
        if (navigator.onLine === false || !text || text.trim().length < 10) return null;
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 25000);
            const res = await fetch(API_BASE + '/api/extract', { method: 'POST', signal: ctrl.signal,
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, text: redact(text) }) }).finally(() => clearTimeout(t));
            if (!res.ok) return null;
            const d = (await res.json())?.data;
            return d && typeof d === 'object' ? d : null;
        } catch (e) { console.warn('KI-Auslesen:', e.message || e); return null; }
    }

    // Ergebnisse zusammenführen: Barcode ist verlässlich (Flugnummer, Sitz), die Regeln danach,
    // die KI füllt nur, was noch fehlt. sources merkt sich, woher etwas kam (für den Prüfdialog).
    function mergeTransit(rules, codeInfo, ai) {
        const out = { train: '', dep: '', arr: '', terminal: '', gate: '', seat: '', from: '', to: '', date: '' };
        const sources = new Set();
        const take = (src, label) => {
            if (!src) return;
            let used = false;
            for (const k of Object.keys(out)) {
                const v = k === 'train' ? (src.train || src.number) : src[k];
                if (!out[k] && typeof v === 'string' && v.trim()) { out[k] = v.trim(); used = true; }
            }
            if (used) sources.add(label);
        };
        take(codeInfo, 'Barcode');
        take(rules, 'Text');
        take(ai, 'KI');
        if (!/^\d{2}:\d{2}$/.test(out.dep)) out.dep = '';
        if (!/^\d{2}:\d{2}$/.test(out.arr)) out.arr = '';
        if (/^[A-Z]{3}$/.test(out.from)) out.from = airportLabel(out.from);
        // KI liefert gern "Tokyo, Japan (NRT-Narita Intl.)": auf Kürzel zurückführen
        else { const c = /\(([A-Z]{3})(?=[\s)\-–,])/.exec(out.from); if (c && AIRPORTS[c[1]]) out.from = airportLabel(c[1]); }
        out.from = out.from.slice(0, 60);
        return out.train || out.dep ? { value: out, sources: [...sources] } : null;
    }

    // ─── Prüfdialog ─────────────────────────────────────────────────────────
    // Zeigt, was gelesen wurde; jedes Feld lässt sich vor dem Übernehmen ändern.
    function reviewDialog(kind, value, sources, current) {
        return new Promise(resolve => {
            let dlg = document.getElementById('modal-booking-review');
            if (!dlg) {
                dlg = document.createElement('dialog');
                dlg.id = 'modal-booking-review';
                dlg.setAttribute('aria-labelledby', 'bookingReviewTitle');
                (document.getElementById('app') || document.body).appendChild(dlg);
            }
            const field = (id, label, v, attrs = '') => `<div class="form-group"><label for="${id}">${label}</label><input id="${id}" value="${esc(v || '')}" autocomplete="off" ${attrs}></div>`;
            const route = value.to ? `nach ${/^[A-Z]{3}$/.test(value.to) ? airportLabel(value.to) : value.to}` : '';
            const dateTxt = value.date ? value.date.split('-').reverse().join('.') : '';
            const meta = [route, dateTxt].filter(Boolean).join(' · ');
            const replaced = kind === 'hotel' ? current?.hotel : [current?.train, current?.dep].filter(Boolean).join(' · ');
            dlg.innerHTML = `<h3 id="bookingReviewTitle">${kind === 'hotel' ? 'Unterkunft übernehmen?' : 'Verbindung übernehmen?'}</h3>
                <div class="dialog-body">
                    <p class="form-hint">Gelesen aus: ${esc(sources.join(', ') || 'Text')}${meta ? ` · ${esc(meta)}` : ''}. Bitte kurz prüfen.</p>
                    ${replaced ? `<p class="form-hint">Ersetzt: ${esc(replaced)}</p>` : ''}
                    ${kind === 'hotel' ? field('br-hotel', 'Unterkunft', value.hotel, 'maxlength="80"') : `
                    ${field('br-train', 'Flug / Zug', value.train, 'maxlength="60"')}
                    ${field('br-from', 'Abflughafen / Abfahrt von', value.from, 'maxlength="60" placeholder="z. B. Tokyo Narita (NRT)"')}
                    <div class="input-row">
                        ${field('br-dep', 'Abfahrt / Abflug', value.dep, 'type="time"')}
                        ${field('br-arr', 'Ankunft', value.arr, 'type="time"')}
                    </div>
                    <div class="input-row">
                        ${field('br-terminal', 'Terminal', value.terminal, 'maxlength="20"')}
                        ${field('br-gate', 'Gate / Gleis', value.gate, 'maxlength="20"')}
                    </div>
                    ${field('br-seat', 'Sitz', value.seat, 'maxlength="40"')}`}
                </div>
                <div class="dialog-actions">
                    <button type="button" class="btn" data-br="ok">Übernehmen</button>
                    <button type="button" class="btn btn-secondary" data-br="cancel">Abbrechen</button>
                </div>`;
            let result = null;
            dlg.querySelector('[data-br="ok"]').onclick = () => {
                const v = id => (dlg.querySelector('#' + id)?.value || '').trim();
                result = kind === 'hotel' ? { hotel: v('br-hotel') }
                    : { train: v('br-train'), dep: v('br-dep'), arr: v('br-arr'), from: v('br-from'), terminal: v('br-terminal'), gate: v('br-gate'), seat: v('br-seat') };
                dlg.close();
            };
            dlg.querySelector('[data-br="cancel"]').onclick = () => dlg.close();
            dlg.addEventListener('close', () => resolve(result), { once: true });
            dlg.showModal();
        });
    }

    // Nach dem Anhängen (und beim erneuten Lesen): Daten lesen, prüfen lassen und eintragen.
    // quiet: automatischer Lauf beim Start – kein Dialog; eingetragen wird nur in leere Felder.
    async function suggest(docId, ref, quiet = false) {
        const toast = (msg) => { if (!quiet) (typeof showResultToast === 'function' ? showResultToast(msg, 'ok') : showToast(msg)); };
        const hotel = /^hotel:(-?\d+(?:\.\d+)?)$/.exec(ref || '');
        const isTransit = ref === 'arrival' || ref === 'return' || /^leg:-?\d+(\.\d+)?$/.test(ref || '');
        if (!hotel && !isTransit) return true;
        if (typeof places === 'undefined') return true;
        toast(hotel ? 'Lese Hotelnamen aus der Bestätigung …' : 'Lese Verbindung aus der Bestätigung …');
        let read;
        try { read = await readDocument(docId, isTransit); }
        catch (e) { console.warn('Buchung lesen:', e); toast('Bestätigung konnte nicht gelesen werden – bitte selbst eintragen'); return false; }
        const text = String(read.text || '');
        const codeInfo = (read.codes || []).map(c => parseBCBP(c)).find(Boolean) || null;
        if (!text.trim() && !codeInfo) { toast('Kein Text in der Bestätigung erkannt – bitte als PDF oder schärferes Foto anhängen'); return true; }
        return hotel ? applyHotel(Number(hotel[1]), text, toast, quiet) : applyTransit(ref, text, codeInfo, toast, quiet);
    }
    async function applyHotel(pid, text, toast, quiet) {
        let name = extractHotelName(text), sources = ['Text'];
        if (!name) {
            if (!quiet) toast('Frage die KI nach dem Hotelnamen …');
            const ai = await aiExtract('hotel', text);
            if (ai?.hotel) { name = ai.hotel; sources = ['KI']; }
        }
        const p = places.find(x => Number(x.id) === pid);
        if (!p) return true;
        if (!name) { toast('Keinen Hotelnamen gefunden – bitte selbst eintragen'); return true; }
        if (p.hotel === name) { toast(`Hotel „${name}“ ist schon eingetragen`); return true; }
        if (quiet) { if (!p.hotel) await saveHotel(pid, name); return true; }
        const ok = await reviewDialog('hotel', { hotel: name }, sources, p.hotel ? { hotel: p.hotel } : null);
        const chosen = ok && ok.hotel.replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!chosen) return true;
        toast(`Hotel „${chosen}“ eingetragen`);
        await saveHotel(pid, chosen);
        return true;
    }
    // Zielfeld der Verbindung: Anreise = Station 1, Rückreise = reiseweit, Etappe = Zielstation.
    function transitSlot(ref) {
        if (ref === 'arrival') return { get: () => places[0]?.transit || null, set: v => { if (places[0]) places[0].transit = v; } };
        if (ref === 'return') return { get: () => window.tripBooking?.return || null, set: v => { window.tripBooking.return = v; } };
        const p = places.find(x => Number(x.id) === Number(ref.slice(4)));
        return p ? { get: () => p.transit || null, set: v => { p.transit = v; } } : null;
    }
    async function applyTransit(ref, text, codeInfo, toast, quiet) {
        const rules = extractTransit(text);
        let merged = mergeTransit(rules, codeInfo, null);
        // KI nur, wenn Flug/Zug oder Abfahrt fehlen
        if (!merged || !merged.value.train || !merged.value.dep) {
            if (!quiet) toast('Frage die KI nach den fehlenden Angaben …');
            const ai = await aiExtract('transit', text);
            if (ai) merged = mergeTransit(rules, codeInfo, ai);
        }
        const slot = transitSlot(ref);
        if (!slot) return true;
        if (!merged) { toast('Keine Zug- oder Flugdaten gefunden – bitte selbst eintragen'); return true; }
        const cur = slot.get();
        let pick = merged.value;
        if (quiet) {
            if (cur && cur.train) {
                // Belegte Verbindung beim Start nie überschreiben – nur den Abflughafen ergänzen,
                // wenn er fehlt und die Bestätigung zur selben Verbindung gehört.
                const norm = x => String(x || '').replace(/\s+/g, '').toUpperCase();
                const add = {};
                if (norm(cur.train) === norm(pick.train)) {
                    if (!cur.from && pick.from) add.from = pick.from;
                    if (!cur.arr && /^\d{2}:\d{2}$/.test(pick.arr || '')) add.arr = pick.arr;
                }
                if (Object.keys(add).length) { slot.set(normTransit({ ...cur, ...add })); saveData(); }
                return true;
            }
        } else {
            const ok = await reviewDialog('transit', pick, merged.sources, cur && (cur.train || cur.dep) ? cur : null);
            if (!ok) return true;
            pick = ok;
        }
        const value = normTransit({ note: cur?.note || '', train: pick.train, dep: /^\d{2}:\d{2}$/.test(pick.dep) ? pick.dep : '',
            arr: /^\d{2}:\d{2}$/.test(pick.arr || '') ? pick.arr : '', from: pick.from || '',
            terminal: pick.terminal || '', gate: pick.gate || '', seat: pick.seat || '' });
        if (!value) return true;
        slot.set(value);
        saveData();
        const found = [value.train, value.from && `ab ${value.from}`, value.dep && `Abfahrt ${value.dep}`, value.arr && `Ankunft ${value.arr}`, value.terminal && `Terminal ${value.terminal}`,
            value.gate && `Gate ${value.gate}`, value.seat && `Sitz ${value.seat}`].filter(Boolean).join(' · ');
        toast(`Eingetragen: ${found}`);
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
    const SCANNED_KEY = 'tp_booking_scanned', RESCAN_KEY = 'tp_booking_rescan_v4';
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
            && !((s => s?.from && s?.arr)(transitSlot(d.ref)?.get())));
        for (const d of empty) {
            if ((s => s?.from && s?.arr)(transitSlot(d.ref)?.get())) continue; // inzwischen von einer anderen Bestätigung gefüllt
            const ok = await suggest(d.id, d.ref, true);
            if (ok) { again.add(d.id); try { localStorage.setItem(RESCAN_KEY, JSON.stringify([...again])); } catch (e) {} }
        }
    }
    // Nach dem Start, wenn Reisedaten und Dokumente geladen sind. Ohne Netz einfach später erneut.
    if (typeof window.document !== 'undefined' && typeof setTimeout === 'function')
        setTimeout(() => { scanExisting().catch(e => console.warn('Bestätigungen nachlesen:', e)); }, 4000);

    window.bookingRead = { extractHotelName, extractTransit, labelLinesFromWords, suggest, scanRef, loadPdfJs, parseBCBP, redact, mergeTransit, airportLabel, prepareForOcr, decodeBarcodes,
        applyTransit: (ref, text, codeInfo, quiet) => applyTransit(ref, text, codeInfo, msg => (typeof showResultToast === 'function' ? showResultToast(msg, 'ok') : showToast(msg)), quiet) };
})();
