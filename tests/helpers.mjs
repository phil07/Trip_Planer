// Gemeinsame Hilfen: lädt Browser-Skripte (IIFEs) und einzelne Funktionen aus app.js in eine vm –
// ohne Kopie des Codes, mit minimaler Fake-Umgebung (window, document, localStorage).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

export const read = rel => readFileSync(new URL(`../Trip-Planer/${rel}`, import.meta.url), 'utf8');

// Zieht `function name(...) {...}` samt Rumpf aus einem Quelltext.
export function grab(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} nicht gefunden`);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1);
}

export function makeStorage(initial = {}) {
    const m = new Map(Object.entries(initial));
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: k => { m.delete(k); },
        get _map() { return m; },
    };
}

const noop = () => {};
function fakeEl() {
    const el = new Proxy(function () {}, {
        get: (t, k) => {
            if (k === Symbol.toPrimitive) return () => '';
            if (k === 'style' || k === 'dataset' || k === 'classList') return new Proxy({}, { get: () => noop, set: () => true });
            if (k === 'children' || k === 'childNodes') return [];
            if (k === 'querySelectorAll') return () => [];
            if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
            return fakeEl();
        },
        set: () => true,
        apply: () => fakeEl(),
    });
    return el;
}

// Führt Quelltext in einem Kontext mit Fake-Browser aus; `globals` werden vorab gesetzt.
export function run(code, globals = {}) {
    const storage = globals.localStorage || makeStorage();
    const win = {};
    const doc = {
        readyState: 'loading', addEventListener: noop, removeEventListener: noop,
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => fakeEl(), body: fakeEl(), head: fakeEl(), documentElement: fakeEl(),
    };
    const ctx = vm.createContext({
        window: win, document: doc, localStorage: storage, console,
        setTimeout: noop, clearTimeout: noop, setInterval: noop, requestAnimationFrame: noop,
        navigator: { language: 'de-DE', onLine: true }, location: { hash: '', href: 'http://localhost/' },
        addEventListener: noop, fetch: () => Promise.reject(new Error('offline')),
        btoa, atob, TextEncoder, TextDecoder, Math, Date, JSON, Set, Map, Number, String, Array, Object, RegExp, Intl, encodeURIComponent, decodeURIComponent,
        ...globals,
    });
    win.window = win; win.localStorage = storage; win.addEventListener = noop; win.removeEventListener = noop; win.matchMedia = () => ({ matches: false, addEventListener: noop });
    vm.runInContext(code, ctx);
    return { ctx, win };
}

// Zieht `const name = ...;` (auch mehrzeilig) aus einem Quelltext.
export function grabConst(src, name) {
    const m = new RegExp(`^const ${name}\\b`, 'm').exec(src);
    assert.ok(m, `const ${name} nicht gefunden`);
    let depth = 0, i = m.index;
    for (; i < src.length; i++) {
        const c = src[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ';' && depth === 0) break;
    }
    return src.slice(m.index, i + 1);
}

// Lädt gewählte Funktionen/Konstanten aus app.js und liefert sie zurück.
export function loadApp({ funcs = [], consts = [], globals = {}, extra = '', also = [] }) {
    const src = read('app.js');
    const code = [...consts.map(n => grabConst(src, n)), ...funcs.map(n => grab(src, n)), extra].join('\n')
        + `\n;__out = { ${[...consts, ...funcs, ...also].join(', ')} };`;
    const { ctx } = run(`var __out; ${code}`, globals);
    return ctx.__out;
}

// Lädt ein Feature-Skript (IIFE) und macht interne Funktionen über window.__t zugänglich.
export function loadFeature(file, internals = [], globals = {}, prelude = '') {
    let src = read(`features/${file}.js`);
    const end = src.lastIndexOf('})');
    src = src.slice(0, end) + `\n;window.__t = { ${internals.join(', ')} };\n` + src.slice(end);
    const { win, ctx } = run(prelude + '\n' + src, globals);
    return { win, ctx, t: win.__t };
}

// Quelltext ausgewählter app.js-Teile als Vorspann für Feature-Skripte (teilen sich einen Kontext).
export function appPrelude({ funcs = [], consts = [] }) {
    const src = read('app.js');
    return [...consts.map(n => grabConst(src, n)), ...funcs.map(n => grab(src, n))].join('\n');
}
// Objekte aus der vm haben andere Prototypen – für deepEqual über JSON angleichen.
export const J = x => JSON.parse(JSON.stringify(x));
