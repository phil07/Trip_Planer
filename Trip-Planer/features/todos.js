// ─── TODOS ──────────────────────────────────────────────────────────────────
// Einfache Aufgabenliste für die Reise: hinzufügen, bearbeiten (Text, Fälligkeit, Notiz),
// abhaken und entfernen. Gespeichert in tp_todos { v: 1, items: [{id, t, due, note, done, doneAt}] },
// Teil von Backup, Teilen und Cloud-Sync (EXPORT_KEYS in app.js).
// Nutzt die globalen Helfer aus app.js: esc, isObj, readJsonKey, writeJson, showToast,
// showUndoToast, haptic.
(function () {
    'use strict';
    const KEY = 'tp_todos';
    const MAX = 300, TEXT_MAX = 120, NOTE_MAX = 500;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const icon = (name, fb) => `<i class="ph-light ph-${name}" data-fb="${fb}" aria-hidden="true"></i>`;
    const uid = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const clean = (s, max) => typeof s === 'string' ? s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max) : '';
    const oneLine = (s, max) => clean(s, max).replace(/\s+/g, ' ');
    let showDone = false, editId = null;

    function load() {
        let raw = {};
        try { raw = readJsonKey(KEY, isObj, {}); } catch (e) {}
        const seen = new Set();
        return (Array.isArray(raw.items) ? raw.items : []).filter(isObj).map(x => ({
            id: typeof x.id === 'string' ? x.id.slice(0, 40) : '',
            t: oneLine(x.t, TEXT_MAX),
            due: typeof x.due === 'string' && DATE_RE.test(x.due) ? x.due : '',
            note: clean(x.note, NOTE_MAX),
            done: !!x.done,
            doneAt: Number.isFinite(x.doneAt) ? x.doneAt : 0
        })).filter(x => x.id && x.t && !seen.has(x.id) && seen.add(x.id)).slice(0, MAX);
    }
    function save(items) {
        return writeJson(KEY, { v: 1, items }); // meldet volle Speicher selbst
    }

    const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    function dueLabel(due) {
        if (!due) return '';
        const t = today();
        const days = Math.round((new Date(due + 'T12:00') - new Date(t + 'T12:00')) / 864e5);
        if (days === 0) return 'Heute';
        if (days === 1) return 'Morgen';
        if (days === -1) return 'Gestern';
        const [y, m, d] = due.split('-');
        return `${d}.${m}.${y !== t.slice(0, 4) ? y.slice(2) : ''}`;
    }
    // Offene: überfällige und fällige zuerst (nach Datum), ohne Datum am Ende in Eingabe-Reihenfolge.
    const byDue = (a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0;

    function row(x) {
        const t = today();
        const overdue = !x.done && x.due && x.due < t;
        const dueTxt = dueLabel(x.due);
        return `<div class="todo-item${x.done ? ' done' : ''}" data-id="${esc(x.id)}">
            <label class="todo-check"><input type="checkbox" data-todo-toggle="${esc(x.id)}" ${x.done ? 'checked' : ''} aria-label="${esc(x.t)} ${x.done ? 'wieder öffnen' : 'abhaken'}"></label>
            <button type="button" class="todo-main" data-todo-edit="${esc(x.id)}" aria-label="${esc(x.t)} bearbeiten">
                <span class="todo-text">${esc(x.t)}</span>
                ${dueTxt || x.note ? `<span class="todo-meta">${dueTxt ? `<span class="todo-due${overdue ? ' overdue' : ''}">${icon('calendar-blank', '📅')} ${overdue ? 'Überfällig · ' : ''}${esc(dueTxt)}</span>` : ''}${x.note ? `<span class="todo-note">${esc(x.note.split('\n')[0])}</span>` : ''}</span>` : ''}
            </button>
            <button type="button" class="todo-del" data-todo-del="${esc(x.id)}" aria-label="${esc(x.t)} entfernen">${icon('x', '✕')}</button>
        </div>`;
    }

    function render() {
        const box = document.getElementById('todoContent');
        if (!box) return;
        const items = load();
        const open = items.filter(x => !x.done).sort(byDue);
        const done = items.filter(x => x.done).sort((a, b) => b.doneAt - a.doneAt);
        const keep = document.activeElement?.id === 'todoAddInput' ? document.getElementById('todoAddInput').value : null;
        box.innerHTML = `
        <form class="todo-add" id="todoAddForm" autocomplete="off">
            <input type="text" id="todoAddInput" maxlength="${TEXT_MAX}" placeholder="Neue Aufgabe …" aria-label="Neue Aufgabe" enterkeyhint="done">
            <button type="submit" class="todo-add-btn" aria-label="Aufgabe hinzufügen">${icon('plus', '+')}</button>
        </form>
        ${items.length ? '' : '<div class="empty-acts">Noch keine Aufgaben.<br>Zum Beispiel: Visum prüfen, JR Pass bestellen, Reiseversicherung abschließen.</div>'}
        ${open.length ? `<div class="todo-list" aria-label="Offene Aufgaben">${open.map(row).join('')}</div>`
            : items.length ? '<p class="todo-alldone">Alles erledigt.</p>' : ''}
        ${done.length ? `<div class="todo-done-head">
                <button type="button" class="todo-done-toggle" id="todoDoneToggle" aria-expanded="${showDone}">${icon(showDone ? 'caret-down' : 'caret-right', showDone ? '▾' : '▸')} Erledigt (${done.length})</button>
                ${showDone ? '<button type="button" class="link-btn todo-clear" id="todoClearDone">Erledigte löschen</button>' : ''}
            </div>
            ${showDone ? `<div class="todo-list" aria-label="Erledigte Aufgaben">${done.map(row).join('')}</div>` : ''}` : ''}`;
        if (keep !== null) { const inp = document.getElementById('todoAddInput'); inp.value = keep; inp.focus(); }
        updateMenuCount(open.length);
    }
    function updateMenuCount(n) {
        const b = document.getElementById('menu-todos-count');
        if (b) { b.textContent = n ? String(n) : ''; b.hidden = !n; }
    }

    function add(text) {
        const t = oneLine(text, TEXT_MAX);
        if (!t) return false;
        const items = load();
        if (items.length >= MAX) { showToast(`Maximal ${MAX} Aufgaben`); return false; }
        items.push({ id: uid(), t, due: '', note: '', done: false, doneAt: 0 });
        save(items); haptic(12);
        return true;
    }
    function toggle(id, on) {
        const items = load(), it = items.find(x => x.id === id);
        if (!it) return render();
        it.done = on; it.doneAt = on ? Date.now() : 0;
        save(items); haptic(on ? 15 : 8); render();
    }
    function remove(id) {
        const items = load(), idx = items.findIndex(x => x.id === id);
        if (idx < 0) return;
        const [removed] = items.splice(idx, 1);
        save(items); haptic(10); render();
        showUndoToast(`„${removed.t}“ entfernt`, () => {
            const cur = load();
            if (cur.some(x => x.id === removed.id)) return;
            cur.splice(Math.min(idx, cur.length), 0, removed);
            save(cur); render();
        });
    }
    function clearDone() {
        const items = load(), before = items.slice();
        const rest = items.filter(x => !x.done);
        if (rest.length === items.length) return;
        save(rest); haptic(10); render();
        showUndoToast(`${items.length - rest.length} erledigte gelöscht`, () => { save(before); render(); });
    }

    // ─── Bearbeiten-Dialog ──────────────────────────────────────────────────
    function openEdit(id) {
        const it = load().find(x => x.id === id);
        if (!it) return render();
        editId = id;
        document.getElementById('todo-text').value = it.t;
        document.getElementById('todo-due').value = it.due;
        document.getElementById('todo-note').value = it.note;
        document.getElementById('todo-done').checked = it.done;
        document.getElementById('modal-todo').showModal();
    }
    function saveEdit() {
        const t = oneLine(document.getElementById('todo-text').value, TEXT_MAX);
        if (!t) { showToast('Bitte einen Text eingeben'); document.getElementById('todo-text').focus(); return; }
        const dueRaw = document.getElementById('todo-due').value;
        const items = load(), it = items.find(x => x.id === editId);
        if (it) {
            const done = document.getElementById('todo-done').checked;
            Object.assign(it, { t, due: DATE_RE.test(dueRaw) ? dueRaw : '', note: clean(document.getElementById('todo-note').value, NOTE_MAX) });
            if (done !== it.done) { it.done = done; it.doneAt = done ? Date.now() : 0; }
            save(items); haptic(12);
        }
        document.getElementById('modal-todo').close();
        render();
    }

    function init() {
        const app = document.getElementById('app') || document.body;
        if (document.getElementById('modal-todo')) return;
        const tpl = document.createElement('template');
        tpl.innerHTML = `
    <dialog id="modal-todo" aria-labelledby="modal-todo-title">
        <h3 id="modal-todo-title">Aufgabe bearbeiten</h3>
        <div class="dialog-body">
            <div class="form-group"><label for="todo-text">Aufgabe</label><input type="text" id="todo-text" maxlength="${TEXT_MAX}" autocomplete="off"></div>
            <div class="form-group"><label for="todo-due">Fällig am (optional)</label><input type="date" id="todo-due"></div>
            <div class="form-group"><label for="todo-note">Notiz (optional)</label><textarea id="todo-note" rows="3" maxlength="${NOTE_MAX}"></textarea></div>
            <label class="todo-done-field"><input type="checkbox" id="todo-done"> Erledigt</label>
        </div>
        <div class="dialog-actions">
            <button type="button" class="btn" id="todoSaveBtn">Speichern</button>
            <button type="button" class="btn btn-secondary" data-todo-close>Abbrechen</button>
            <button type="button" class="btn btn-secondary todo-del-btn" id="todoDeleteBtn">Löschen</button>
        </div>
    </dialog>`;
        app.appendChild(tpl.content);
        const dlg = document.getElementById('modal-todo');
        document.getElementById('todoSaveBtn').addEventListener('click', saveEdit);
        document.getElementById('todoDeleteBtn').addEventListener('click', () => { const id = editId; dlg.close(); remove(id); });
        dlg.querySelector('[data-todo-close]').addEventListener('click', () => dlg.close());
        document.getElementById('todo-text').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveEdit(); } });

        const view = document.getElementById('view-todos');
        view?.addEventListener('submit', e => {
            if (e.target.id !== 'todoAddForm') return;
            e.preventDefault();
            const inp = document.getElementById('todoAddInput');
            if (add(inp.value)) { inp.value = ''; render(); }
        });
        view?.addEventListener('change', e => {
            const cb = e.target.closest('[data-todo-toggle]');
            if (cb) toggle(cb.dataset.todoToggle, cb.checked);
        });
        view?.addEventListener('click', e => {
            const t = e.target.closest('[data-todo-edit],[data-todo-del],#todoDoneToggle,#todoClearDone');
            if (!t) return;
            if (t.dataset.todoEdit) openEdit(t.dataset.todoEdit);
            else if (t.dataset.todoDel) remove(t.dataset.todoDel);
            else if (t.id === 'todoDoneToggle') { showDone = !showDone; render(); }
            else if (t.id === 'todoClearDone') clearDone();
        });
        // Anzahl offener Aufgaben im Menü, auch ohne die Seite geöffnet zu haben
        updateMenuCount(load().filter(x => !x.done).length);
        if (view?.classList.contains('active')) render();
    }

    window.todos = { render, add, load };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
