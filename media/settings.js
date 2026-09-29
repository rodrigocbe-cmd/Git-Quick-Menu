// Git Settings page. Renders the sections sent by src/settingsPanel.ts and
// posts every change back to the extension, which replies with the new state.
(function () {
    const vscode = acquireVsCodeApi();
    const { sections, strings } = JSON.parse(document.getElementById('init').textContent);
    const root = document.getElementById('root');
    let state;
    let selectedRemote;
    // Text typed but not saved yet, by field id: survives re-renders caused by refreshes.
    const drafts = {};

    window.addEventListener('message', event => {
        if (event.data.type === 'state') {
            state = event.data;
            render();
        }
    });
    vscode.postMessage({ type: 'ready' });

    function el(tag, attributes, ...children) {
        const element = document.createElement(tag);
        for (const [name, value] of Object.entries(attributes || {})) {
            if (name.startsWith('on')) {
                element.addEventListener(name.slice(2), value);
            } else if (value !== undefined && value !== false) {
                element.setAttribute(name, value === true ? '' : value);
            }
        }
        for (const child of children.flat()) {
            if (child !== undefined && child !== null) {
                element.append(child);
            }
        }
        return element;
    }

    function button(label, onclick, disabled) {
        return el('button', { class: 'secondary', onclick, disabled: !!disabled }, label);
    }

    function command(id, name) {
        vscode.postMessage({ type: 'command', id, name });
    }

    function render() {
        // Keep the scroll position and the focused field across re-renders.
        const scroll = window.scrollY;
        const focusedId = document.activeElement && document.activeElement.id;
        root.replaceChildren(...sections.map(renderSection));
        if (focusedId && document.getElementById(focusedId)) {
            document.getElementById(focusedId).focus();
        }
        window.scrollTo(0, scroll);
    }

    function renderSection(section) {
        const header = [el('h2', {}, section.title)];
        const body = [];
        if (section.scope === 'vscode' && section.id === 'extension') {
            header.push(button(strings.openVsCodeSettings, () => command('openVsCodeSettings')));
        }
        if (section.scope !== 'vscode') {
            body.push(button(strings.refresh, () => vscode.postMessage({ type: 'refresh' })));
            body.push(el('p', { class: 'description' }, section.description));
        }
        if (section.scope === 'global') {
            if (state.gitVersion) {
                body.push(el('p', { class: 'description' }, state.gitVersion));
            }
            body.push(el('div', { class: 'actions' }, button(`${strings.openFile} (~/.gitconfig)`, () => command('openGlobalConfig'))));
        }
        if (section.scope === 'local') {
            if (!state.repository) {
                body.push(el('p', { class: 'empty' }, strings.noRepository));
                return el('section', {}, el('div', { class: 'header' }, header), el('div', { class: 'box' }, body));
            }
            body.push(
                el('div', { class: 'actions' },
                    button(strings.editGitignore, () => command('editGitignore')),
                    button(strings.editGitattributes, () => command('editGitattributes')),
                    button(`${strings.openFile} (.git/config)`, () => command('openRepositoryConfig'))
                ),
                renderRepositoryPicker()
            );
        }
        body.push(...section.fields.map(field => renderField(section, field)));
        if (section.scope === 'local') {
            body.push(renderRemotes());
        }
        const content = section.scope === 'vscode' ? body : [el('div', { class: 'box' }, body)];
        return el('section', {}, el('div', { class: 'header' }, header), content);
    }

    function renderRepositoryPicker() {
        const select = el('select', {
            id: 'repository',
            onchange: () => vscode.postMessage({ type: 'selectRepository', root: select.value })
        }, state.repositories.map(r => el('option', { value: r.root, selected: r.root === state.repository, title: r.root }, r.name)));
        return el('div', { class: 'field' },
            el('label', { for: 'repository' }, strings.repository),
            select,
            el('div', {}, button(strings.openRepositoryFolder, () => command('openRepositoryFolder')))
        );
    }

    function renderField(section, field) {
        const id = `${section.id}:${field.key}`;
        const value = state.values[section.scope][field.key];
        const inherited = section.scope === 'local' ? state.values.global[field.key] : undefined;
        const set = newValue =>
            section.scope === 'vscode'
                ? vscode.postMessage({ type: 'setSetting', key: field.key, value: newValue })
                : vscode.postMessage({ type: 'setGitConfig', scope: section.scope, key: field.key, value: newValue });
        const description = field.description ? el('p', { class: 'description' }, field.description) : undefined;

        if (field.type === 'checkbox') {
            const input = el('input', { type: 'checkbox', id, checked: !!value, onchange: () => set(input.checked) });
            return el('div', { class: 'field checkbox' }, input, el('label', { for: id }, field.label, description));
        }

        let control;
        if (field.type === 'select') {
            const options = [...field.options];
            if (value !== undefined && value !== '' && !options.some(o => String(o.value) === String(value))) {
                options.push({ value, label: String(value) });
            }
            const unsetLabel = inherited !== undefined ? `${strings.unset} (${strings.inherited.replace('{0}', inherited)})` : strings.unset;
            const choices = section.scope === 'vscode' ? options : [{ value: '', label: unsetLabel }, ...options];
            control = el('select', {
                id,
                onchange: () => set(section.scope === 'vscode' ? JSON.parse(control.value) : control.value)
            }, choices.map(o => {
                const encoded = section.scope === 'vscode' ? JSON.stringify(o.value) : String(o.value);
                const current = section.scope === 'vscode' ? JSON.stringify(value) : String(value ?? '');
                return el('option', { value: encoded, selected: encoded === current }, o.label);
            }));
        } else {
            const placeholder = inherited !== undefined ? strings.inherited.replace('{0}', inherited) : field.placeholder;
            control = el('input', {
                id,
                type: field.type === 'number' ? 'number' : 'text',
                value: id in drafts ? drafts[id] : value ?? '',
                placeholder,
                oninput: () => { drafts[id] = control.value; },
                onchange: () => {
                    delete drafts[id];
                    set(field.type === 'number' ? Number(control.value) : control.value);
                }
            });
            control.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    control.blur();
                }
            });
        }
        const row = field.type === 'folder'
            ? el('div', { class: 'row' }, control, button(strings.browse, () => vscode.postMessage({ type: 'browseFolder', key: field.key })))
            : control;
        return el('div', { class: 'field' }, el('label', { for: id }, field.label), description, row);
    }

    function renderRemotes() {
        if (!state.remotes.some(r => r.name === selectedRemote)) {
            selectedRemote = state.remotes[0] && state.remotes[0].name;
        }
        const rows = state.remotes.map(r =>
            el('tr', {
                class: r.name === selectedRemote ? 'selected' : undefined,
                tabindex: '0',
                onclick: () => { selectedRemote = r.name; render(); },
                ondblclick: () => command('editRemote', r.name)
            }, el('td', {}, r.name), el('td', {}, r.fetchUrl), el('td', {}, r.pushUrl))
        );
        const table = el('table', {},
            el('thead', {}, el('tr', {}, el('th', {}, strings.name), el('th', {}, strings.fetch), el('th', {}, strings.push))),
            el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: '3', class: 'empty' }, strings.noRemotes)))
        );
        return el('div', { class: 'field' },
            el('label', {}, strings.remotes),
            table,
            el('div', { class: 'actions' },
                button(`+ ${strings.add}`, () => command('addRemote')),
                button(strings.edit, () => command('editRemote', selectedRemote), !selectedRemote),
                button(strings.remove, () => command('removeRemote', selectedRemote), !selectedRemote)
            )
        );
    }
})();
