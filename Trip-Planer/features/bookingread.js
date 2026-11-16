// ─── HOTELNAME AUS BUCHUNGSBESTÄTIGUNG LESEN ─────────────────────────────────
// Wird eine Bestätigung an eine Unterkunft angehängt, liest die App den Text aus:
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

    // Reiner Text -> Hotelname oder ''. Zuerst Zeilen mit Beschriftung ("Hotel: X"), dann freie Zeilen mit Schlüsselwort.
    function extractHotelName(text) {
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

    // Nach dem Anhängen an eine Unterkunft: Namen lesen und in die Station eintragen.
    async function suggest(docId, ref) {
        const m = /^hotel:(-?\d+(?:\.\d+)?)$/.exec(ref || '');
        if (!m || typeof places === 'undefined') return;
        const pid = Number(m[1]);
        const toast = (msg, ms) => (typeof showResultToast === 'function' ? showResultToast(msg, 'ok') : showToast(msg, ms));
        toast('Lese Hotelnamen aus der Bestätigung …');
        let name = '';
        try { name = extractHotelName(await readDocument(docId)); }
        catch (e) { console.warn('Buchung lesen:', e); toast('Bestätigung konnte nicht gelesen werden – Hotel bitte selbst eintragen'); return; }
        const p = places.find(x => Number(x.id) === pid);
        if (!p) return;
        if (!name) { toast('Keinen Hotelnamen gefunden – bitte selbst eintragen'); return; }
        if (p.hotel === name) { toast(`Hotel „${name}“ ist schon eingetragen`); return; }
        if (!p.hotel) { toast(`Hotel „${name}“ eingetragen`); await saveHotel(pid, name); return; }
        if (confirm(`Aus der Bestätigung gelesen: „${name}“.\n\nStatt „${p.hotel}“ in der Station eintragen?`)) {
            toast(`Hotel „${name}“ eingetragen`);
            await saveHotel(pid, name);
        }
    }

    window.bookingRead = { extractHotelName, suggest };
})();
