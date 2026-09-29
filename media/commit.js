// Git Changes page. Renders the state sent by src/commitPanel.ts and posts
// the user's actions back. The message box is created once and never
// re-rendered, so typing is never lost when the repository refreshes.
(function () {
    const vscode = acquireVsCodeApi();
    const { strings } = JSON.parse(document.getElementById('init').textContent);
    const root = document.getElementById('root');
    let state;
    let pushDefault = false;
    let draftTimer;

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

    // ------------------------------------------------------------ static part

    const repositorySelect = el('select', {
        id: 'repository',
        onchange: () => vscode.postMessage({ type: 'selectRepository', root: repositorySelect.value })
    });
    const repositoryRow = el('div', { class: 'meta' }, el('label', { for: 'repository' }, strings.repository), repositorySelect);
    const branchInfo = el('span', { class: 'branch' });
    const authorText = el('span', { class: 'author-text' });
    const message = el('textarea', {
        id: 'message',
        rows: '6',
        placeholder: strings.messagePlaceholder,
        oninput: () => {
            clearTimeout(draftTimer);
            draftTimer = setTimeout(() => vscode.postMessage({ type: 'draft', message: message.value }), 300);
            updateButtons();
        },
        onkeydown: event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                commit(pushDefault);
            }
        }
    });
    const amend = el('input', { type: 'checkbox', id: 'amend', onchange: () => updateButtons() });
    const primary = el('button', { class: 'primary', onclick: () => commit(pushDefault) });
    const secondary = el('button', { class: 'secondary', onclick: () => commit(!pushDefault) });
    const stash = el('button', {
        class: 'secondary',
        onclick: () => vscode.postMessage({ type: 'stash', message: message.value })
    }, strings.stashAll);
    const lists = el('div', { class: 'lists' });
    const empty = el('p', { class: 'empty' }, strings.noRepository);

    const form = el('div', { class: 'form' },
        repositoryRow,
        el('div', { class: 'meta' }, el('span', { class: 'label' }, strings.branch), branchInfo),
        el('div', { class: 'meta author' },
            el('span', { class: 'label' }, strings.author),
            authorText,
            el('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'changeAuthor' }) }, strings.changeAuthor)
        ),
        message,
        el('div', { class: 'field checkbox' }, amend, el('label', { for: 'amend' }, strings.amend)),
        el('div', { class: 'actions' }, primary, secondary, stash),
        el('p', { class: 'description' }, strings.shortcut)
    );
    root.append(
        el('div', { class: 'header' },
            el('h2', {}, strings.title),
            el('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'refresh' }) }, strings.refresh)
        ),
        empty,
        form,
        lists
    );

    function commit(push) {
        vscode.postMessage({ type: 'commit', message: message.value, amend: amend.checked, push });
    }

    function updateButtons() {
        const hasStaged = state && state.staged && state.staged.length > 0;
        const hasChanges = hasStaged || (state && state.changes && state.changes.length > 0);
        const commitLabel = amend.checked ? strings.amendCommit : hasStaged ? strings.commitStaged : strings.commitAll;
        primary.textContent = pushDefault ? strings.commitAndPush : commitLabel;
        secondary.textContent = pushDefault ? commitLabel : strings.commitAndPush;
        const canCommit = message.value.trim() !== '' && (hasChanges || amend.checked);
        primary.disabled = !canCommit;
        secondary.disabled = !canCommit;
        stash.disabled = !hasChanges;
    }

    // ------------------------------------------------------------ state

    window.addEventListener('message', event => {
        const data = event.data;
        if (data.type === 'focus') {
            pushDefault = data.push;
            updateButtons();
            message.focus();
        } else if (data.type === 'clear') {
            message.value = '';
            amend.checked = false;
            updateButtons();
        } else if (data.type === 'state') {
            const first = !state;
            state = data;
            render(first);
        }
    });
    vscode.postMessage({ type: 'ready' });

    function render(first) {
        const hasRepository = state.repositories.length > 0;
        empty.hidden = hasRepository;
        form.hidden = !hasRepository;
        lists.hidden = !hasRepository;
        if (!hasRepository) {
            return;
        }
        repositorySelect.replaceChildren(...state.repositories.map(r =>
            el('option', { value: r.root, selected: r.root === state.repository, title: r.root }, r.name)));
        repositoryRow.hidden = state.repositories.length < 2;

        const sync = [];
        if (state.ahead) { sync.push(`↑ ${strings.outgoing.replace('{0}', state.ahead)}`); }
        if (state.behind) { sync.push(`↓ ${strings.incoming.replace('{0}', state.behind)}`); }
        branchInfo.textContent = state.branch + (sync.length ? `  (${sync.join(', ')})` : '');

        const { name, email } = state.author;
        authorText.textContent = name || email ? `${name} <${email}>` : strings.noAuthor;
        authorText.classList.toggle('warning', !name || !email);

        // Only restore the shared draft when the box is not being edited.
        if (first || (document.activeElement !== message && !message.value)) {
            message.value = state.draft || '';
        }
        lists.replaceChildren(
            renderGroup(strings.staged, state.staged, true),
            renderGroup(strings.changes, state.changes, false)
        );
        updateButtons();
    }

    function renderGroup(title, items, staged) {
        const action = staged ? strings.unstage : strings.stage;
        const type = staged ? 'unstage' : 'stage';
        const header = el('div', { class: 'group-header' },
            el('span', { class: 'group-title' }, `${title} (${items.length})`),
            items.length
                ? el('button', { class: 'secondary small', onclick: () => vscode.postMessage({ type, paths: items.map(i => i.path) }) },
                    staged ? strings.unstageAll : strings.stageAll)
                : undefined
        );
        if (staged && items.length === 0) {
            return el('div', { class: 'group' }, header);
        }
        const rows = items.length
            ? items.map(item => el('li', {
                title: `${item.folder ? item.folder + '/' : ''}${item.name} — ${item.description}`,
                onclick: () => vscode.postMessage({ type: 'open', path: item.path, staged })
            },
                el('span', { class: `status status-${item.letter}` }, item.letter),
                el('span', { class: 'file-name' }, item.name),
                el('span', { class: 'file-folder' }, item.folder),
                el('button', {
                    class: 'icon',
                    title: action,
                    onclick: event => {
                        event.stopPropagation();
                        vscode.postMessage({ type, paths: [item.path] });
                    }
                }, staged ? '−' : '+')
            ))
            : [el('li', { class: 'empty' }, strings.noChanges)];
        return el('div', { class: 'group' }, header, el('ul', {}, rows));
    }
})();
