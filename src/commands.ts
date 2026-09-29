import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage, GitService, runGit } from './gitService';
import { Ref, RefType, Repository } from './typings/git';

type RepositoryCommand = (repository: Repository) => Promise<unknown>;

export function registerCommands(context: vscode.ExtensionContext, git: GitService): void {
    const repositoryCommands: Record<string, RepositoryCommand> = {
        'gitQuickMenu.newBranch': newBranch,
        'gitQuickMenu.checkout': checkout,
        'gitQuickMenu.commit': commit,
        'gitQuickMenu.commitAndPush': commitAndPush,
        'gitQuickMenu.pull': pull,
        'gitQuickMenu.push': push,
        'gitQuickMenu.fetch': fetch,
        'gitQuickMenu.sync': sync,
        'gitQuickMenu.manageBranches': manageBranches,
        'gitQuickMenu.manageRemotes': manageRemotes,
        'gitQuickMenu.stash': stash,
        'gitQuickMenu.log': log
    };

    for (const [id, handler] of Object.entries(repositoryCommands)) {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, async () => {
                const repository = await git.pickRepository();
                if (repository) {
                    await guarded(() => handler(repository));
                }
            })
        );
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('gitQuickMenu.settings', () =>
            guarded(() => settings(context, git))
        )
    );
}

async function guarded(task: () => Promise<unknown>): Promise<void> {
    try {
        await task();
    } catch (error) {
        vscode.window.showErrorMessage(`Git: ${errorMessage(error)}`);
    }
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

// ---------------------------------------------------------------- branches

async function newBranch(repository: Repository): Promise<void> {
    const base = await pickBranch(repository, {
        title: 'New Branch (1/2): Based on',
        placeHolder: 'Select the branch the new branch will be based on',
        includeRemote: true
    });
    if (!base?.name) {
        return;
    }
    const name = await vscode.window.showInputBox({
        title: 'New Branch (2/2): Name',
        prompt: `Create a new branch from '${base.name}' and check it out`,
        placeHolder: 'feature/my-branch',
        validateInput: validateBranchName
    });
    if (!name) {
        return;
    }
    await repository.createBranch(name.trim(), true, base.name);
    vscode.window.showInformationMessage(`Switched to new branch '${name.trim()}'.`);
}

async function checkout(repository: Repository): Promise<void> {
    const ref = await pickBranch(repository, {
        title: 'Checkout',
        placeHolder: 'Select a branch to check out',
        includeRemote: true
    });
    if (ref) {
        await checkoutRef(repository, ref);
    }
}

/** Checks out a branch; a remote branch becomes a local tracking branch. */
async function checkoutRef(repository: Repository, ref: Ref): Promise<void> {
    if (!ref.name) {
        return;
    }
    if (ref.type === RefType.RemoteHead && ref.remote) {
        const localName = ref.name.slice(ref.remote.length + 1);
        const locals = await repository.getBranches({ remote: false });
        if (locals.some(branch => branch.name === localName)) {
            await repository.checkout(localName);
        } else {
            await repository.createBranch(localName, true, ref.name);
        }
    } else {
        await repository.checkout(ref.name);
    }
}

async function manageBranches(repository: Repository): Promise<void> {
    type Item = vscode.QuickPickItem & { ref?: Ref; create?: boolean };
    const refs = await listBranches(repository, true);
    const current = repository.state.HEAD?.name;
    const items: Item[] = [
        { label: '$(add) New Branch...', create: true },
        ...branchItems(refs, current)
    ];
    const pick = await vscode.window.showQuickPick<Item>(items, {
        title: 'Manage Branches',
        placeHolder: 'Select a branch',
        matchOnDescription: true
    });
    if (!pick) {
        return;
    }
    if (pick.create) {
        return newBranch(repository);
    }
    const ref = pick.ref!;
    const name = ref.name!;
    const isLocal = ref.type === RefType.Head;
    const isCurrent = isLocal && name === current;

    const actions: (vscode.QuickPickItem & { id: string })[] = [];
    if (!isCurrent) {
        actions.push({ id: 'checkout', label: '$(git-branch) Checkout' });
        if (current) {
            actions.push({ id: 'merge', label: `$(git-merge) Merge into '${current}'` });
        }
    }
    if (isLocal) {
        actions.push({ id: 'rename', label: '$(edit) Rename...' });
        if (!isCurrent) {
            actions.push({ id: 'delete', label: '$(trash) Delete' });
        }
    }
    actions.push({ id: 'copy', label: '$(copy) Copy Branch Name' });

    const action = await vscode.window.showQuickPick(actions, { title: `Branch '${name}'` });
    switch (action?.id) {
        case 'checkout':
            return checkoutRef(repository, ref);
        case 'merge':
            await withProgress(`Merging '${name}' into '${current}'...`, () =>
                runGit(repository, ['merge', name])
            );
            await repository.status();
            vscode.window.showInformationMessage(`Merged '${name}' into '${current}'.`);
            return;
        case 'rename': {
            const newName = await vscode.window.showInputBox({
                title: `Rename Branch '${name}'`,
                value: name,
                validateInput: validateBranchName
            });
            if (newName && newName.trim() !== name) {
                await runGit(repository, ['branch', '-m', name, newName.trim()]);
                await repository.status();
            }
            return;
        }
        case 'delete':
            return deleteBranch(repository, name);
        case 'copy':
            await vscode.env.clipboard.writeText(name);
            return;
    }
}

async function deleteBranch(repository: Repository, name: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
        `Delete branch '${name}'?`,
        { modal: true },
        'Delete'
    );
    if (confirm !== 'Delete') {
        return;
    }
    try {
        await repository.deleteBranch(name, false);
    } catch (error) {
        const force = await vscode.window.showWarningMessage(
            `Branch '${name}' could not be deleted: ${errorMessage(error)}`,
            { modal: true },
            'Force Delete'
        );
        if (force === 'Force Delete') {
            await repository.deleteBranch(name, true);
        }
    }
}

// ---------------------------------------------------------------- commit / sync

/** Commits the staged changes (or all changes, after confirmation). Returns true on success. */
async function commit(repository: Repository): Promise<boolean> {
    await repository.status();
    const { indexChanges, workingTreeChanges, mergeChanges } = repository.state;
    if (indexChanges.length === 0 && workingTreeChanges.length === 0 && mergeChanges.length === 0) {
        vscode.window.showInformationMessage('There are no changes to commit.');
        return false;
    }

    let commitAll = false;
    if (indexChanges.length === 0) {
        const choice = await vscode.window.showWarningMessage(
            'There are no staged changes. Stage all changes and commit them?',
            { modal: true },
            'Stage All & Commit'
        );
        if (!choice) {
            return false;
        }
        commitAll = true;
    }

    const message = await vscode.window.showInputBox({
        title: 'Commit',
        prompt: commitAll
            ? `Commit all ${workingTreeChanges.length} changed file(s)`
            : `Commit ${indexChanges.length} staged file(s)`,
        placeHolder: 'Commit message',
        value: repository.inputBox.value,
        validateInput: value => (value.trim() ? undefined : 'The commit message cannot be empty.')
    });
    if (!message) {
        return false;
    }

    await repository.commit(message, commitAll ? { all: true } : undefined);
    repository.inputBox.value = '';
    vscode.window.setStatusBarMessage(`$(check) Committed: ${message.split('\n')[0]}`, 5000);
    return true;
}

async function commitAndPush(repository: Repository): Promise<void> {
    if (await commit(repository)) {
        await push(repository);
    }
}

async function pull(repository: Repository): Promise<void> {
    const head = repository.state.HEAD;
    if (!head?.upstream) {
        vscode.window.showWarningMessage(
            head?.name
                ? `Branch '${head.name}' has no upstream branch. Push it first to publish it.`
                : 'Cannot pull: HEAD is detached.'
        );
        return;
    }
    await withProgress(`Pulling '${head.name}'...`, () => repository.pull());
    vscode.window.setStatusBarMessage('$(check) Pull complete', 5000);
}

async function push(repository: Repository): Promise<void> {
    const head = repository.state.HEAD;
    if (!head?.name) {
        vscode.window.showWarningMessage('Cannot push: HEAD is detached.');
        return;
    }
    if (head.upstream) {
        await withProgress(`Pushing '${head.name}'...`, () => repository.push());
    } else {
        const remote = await pickRemote(repository, `Select a remote to publish '${head.name}' to`);
        if (!remote) {
            return;
        }
        await withProgress(`Publishing '${head.name}' to '${remote}'...`, () =>
            repository.push(remote, head.name, true)
        );
    }
    vscode.window.setStatusBarMessage('$(check) Push complete', 5000);
}

async function fetch(repository: Repository): Promise<void> {
    if (repository.state.remotes.length === 0) {
        vscode.window.showWarningMessage('This repository has no remotes to fetch from.');
        return;
    }
    await withProgress('Fetching...', () => repository.fetch({ all: true }));
    vscode.window.setStatusBarMessage('$(check) Fetch complete', 5000);
}

async function sync(repository: Repository): Promise<void> {
    if (repository.state.HEAD?.upstream) {
        await pull(repository);
    }
    await push(repository);
}

// ---------------------------------------------------------------- remotes

async function manageRemotes(repository: Repository): Promise<void> {
    type Item = vscode.QuickPickItem & { remote?: string };
    const items: Item[] = [
        { label: '$(add) Add Remote...' },
        ...repository.state.remotes.map(remote => ({
            label: `$(remote) ${remote.name}`,
            description: remote.fetchUrl ?? remote.pushUrl,
            remote: remote.name
        }))
    ];
    const pick = await vscode.window.showQuickPick<Item>(items, {
        title: 'Manage Remotes',
        placeHolder: 'Select a remote'
    });
    if (!pick) {
        return;
    }
    if (!pick.remote) {
        return addRemote(repository);
    }

    const name = pick.remote;
    const url = pick.description ?? '';
    const action = await vscode.window.showQuickPick(
        [
            { id: 'fetch', label: '$(cloud-download) Fetch' },
            { id: 'url', label: '$(link) Change URL...' },
            { id: 'rename', label: '$(edit) Rename...' },
            { id: 'copy', label: '$(copy) Copy URL' },
            { id: 'remove', label: '$(trash) Remove' }
        ],
        { title: `Remote '${name}'` }
    );
    switch (action?.id) {
        case 'fetch':
            await withProgress(`Fetching '${name}'...`, () => repository.fetch({ remote: name }));
            return;
        case 'url': {
            const newUrl = await vscode.window.showInputBox({ title: `URL of '${name}'`, value: url });
            if (newUrl && newUrl.trim() !== url) {
                await runGit(repository, ['remote', 'set-url', name, newUrl.trim()]);
                await repository.status();
            }
            return;
        }
        case 'rename': {
            const newName = await vscode.window.showInputBox({
                title: `Rename Remote '${name}'`,
                value: name,
                validateInput: validateRemoteName
            });
            if (newName && newName.trim() !== name) {
                await runGit(repository, ['remote', 'rename', name, newName.trim()]);
                await repository.status();
            }
            return;
        }
        case 'copy':
            await vscode.env.clipboard.writeText(url);
            return;
        case 'remove': {
            const confirm = await vscode.window.showWarningMessage(
                `Remove remote '${name}'?`,
                { modal: true },
                'Remove'
            );
            if (confirm === 'Remove') {
                await repository.removeRemote(name);
            }
            return;
        }
    }
}

async function addRemote(repository: Repository): Promise<void> {
    const name = await vscode.window.showInputBox({
        title: 'Add Remote (1/2): Name',
        value: repository.state.remotes.length === 0 ? 'origin' : '',
        validateInput: validateRemoteName
    });
    if (!name) {
        return;
    }
    const url = await vscode.window.showInputBox({
        title: 'Add Remote (2/2): URL',
        placeHolder: 'https://github.com/user/repo.git',
        validateInput: value => (value.trim() ? undefined : 'The URL cannot be empty.')
    });
    if (!url) {
        return;
    }
    await repository.addRemote(name.trim(), url.trim());
    vscode.window.showInformationMessage(`Remote '${name.trim()}' added.`);
}

// ---------------------------------------------------------------- stash

async function stash(repository: Repository): Promise<void> {
    const action = await vscode.window.showQuickPick(
        [
            { id: 'push', label: '$(archive) Stash Changes...' },
            { id: 'pushUntracked', label: '$(archive) Stash All (Include Untracked)...' },
            { id: 'pop', label: '$(inbox) Pop Stash...' },
            { id: 'apply', label: '$(inbox) Apply Stash...' },
            { id: 'show', label: '$(eye) View Stash...' },
            { id: 'drop', label: '$(trash) Drop Stash...' }
        ],
        { title: 'Stash' }
    );
    if (!action) {
        return;
    }

    if (action.id === 'push' || action.id === 'pushUntracked') {
        const message = await vscode.window.showInputBox({
            title: 'Stash',
            placeHolder: 'Stash message (optional)'
        });
        if (message === undefined) {
            return;
        }
        const args = ['stash', 'push'];
        if (action.id === 'pushUntracked') {
            args.push('--include-untracked');
        }
        if (message.trim()) {
            args.push('-m', message.trim());
        }
        await runGit(repository, args);
        await repository.status();
        return;
    }

    const ref = await pickStash(repository);
    if (!ref) {
        return;
    }
    if (action.id === 'show') {
        await showText(await runGit(repository, ['stash', 'show', '--patch', '--include-untracked', ref]));
        return;
    }
    if (action.id === 'drop') {
        const confirm = await vscode.window.showWarningMessage(
            `Drop ${ref}? This cannot be undone.`,
            { modal: true },
            'Drop'
        );
        if (confirm !== 'Drop') {
            return;
        }
    }
    await runGit(repository, ['stash', action.id, ref]);
    await repository.status();
}

async function pickStash(repository: Repository): Promise<string | undefined> {
    const output = await runGit(repository, ['stash', 'list', '--format=%gd%x1f%s%x1f%cr']);
    const items = output
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
            const [ref, subject, date] = line.split('\x1f');
            return { label: ref, description: subject, detail: date };
        });
    if (items.length === 0) {
        vscode.window.showInformationMessage('There are no stashes.');
        return undefined;
    }
    const pick = await vscode.window.showQuickPick(items, {
        title: 'Select a Stash',
        matchOnDescription: true
    });
    return pick?.label;
}

// ---------------------------------------------------------------- log

async function log(repository: Repository): Promise<void> {
    const maxEntries = vscode.workspace.getConfiguration('gitQuickMenu').get<number>('logMaxEntries', 100);
    const commits = await repository.log({ maxEntries });
    if (commits.length === 0) {
        vscode.window.showInformationMessage('This repository has no commits yet.');
        return;
    }
    const pick = await vscode.window.showQuickPick(
        commits.map(c => ({
            label: `$(git-commit) ${c.message.split('\n')[0]}`,
            description: `${c.hash.slice(0, 7)} · ${c.authorName ?? ''}`,
            detail: c.authorDate?.toLocaleString(),
            hash: c.hash
        })),
        {
            title: `Git Log: ${repository.state.HEAD?.name ?? 'HEAD'}`,
            placeHolder: 'Select a commit to view its changes',
            matchOnDescription: true,
            matchOnDetail: true
        }
    );
    if (pick) {
        await showText(await runGit(repository, ['show', '--stat', '--patch', pick.hash]));
    }
}

// ---------------------------------------------------------------- settings

async function settings(context: vscode.ExtensionContext, git: GitService): Promise<void> {
    const pick = await vscode.window.showQuickPick(
        [
            { id: 'extension', label: '$(settings-gear) Git Quick Menu Settings' },
            { id: 'builtin', label: '$(settings-gear) Built-in Git Settings' },
            { id: 'global', label: '$(file) Global Git Config', description: '~/.gitconfig' },
            { id: 'repository', label: '$(file) Repository Git Config', description: '.git/config' }
        ],
        { title: 'Git Settings' }
    );
    switch (pick?.id) {
        case 'extension':
            await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
            return;
        case 'builtin':
            await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vscode.git');
            return;
        case 'global': {
            const home = process.env.HOME || os.homedir();
            await openFile(vscode.Uri.file(path.join(home, '.gitconfig')));
            return;
        }
        case 'repository': {
            const repository = await git.pickRepository();
            if (repository) {
                const configPath = (await runGit(repository, ['rev-parse', '--git-path', 'config'])).trim();
                await openFile(
                    path.isAbsolute(configPath)
                        ? vscode.Uri.file(configPath)
                        : vscode.Uri.joinPath(repository.rootUri, configPath)
                );
            }
            return;
        }
    }
}

// ---------------------------------------------------------------- helpers

async function listBranches(repository: Repository, includeRemote: boolean): Promise<Ref[]> {
    const refs = await repository.getBranches({ remote: includeRemote, sort: 'committerdate' });
    return refs.filter(ref => ref.name && !ref.name.endsWith('/HEAD'));
}

function branchItems(refs: Ref[], current: string | undefined): (vscode.QuickPickItem & { ref?: Ref })[] {
    const local = refs.filter(ref => ref.type === RefType.Head);
    const remote = refs.filter(ref => ref.type === RefType.RemoteHead);
    const toItem = (ref: Ref, icon: string) => ({
        label: `$(${icon}) ${ref.name}`,
        description: [ref.name === current && ref.type === RefType.Head ? 'current' : '', ref.commit?.slice(0, 7)]
            .filter(Boolean)
            .join(' · '),
        ref
    });
    // Current branch first.
    local.sort((a, b) => Number(b.name === current) - Number(a.name === current));
    const items: (vscode.QuickPickItem & { ref?: Ref })[] = [];
    if (local.length) {
        items.push({ label: 'Local branches', kind: vscode.QuickPickItemKind.Separator });
        items.push(...local.map(ref => toItem(ref, 'git-branch')));
    }
    if (remote.length) {
        items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator });
        items.push(...remote.map(ref => toItem(ref, 'cloud')));
    }
    return items;
}

async function pickBranch(
    repository: Repository,
    options: { title: string; placeHolder: string; includeRemote: boolean }
): Promise<Ref | undefined> {
    const refs = await listBranches(repository, options.includeRemote);
    const pick = await vscode.window.showQuickPick(branchItems(refs, repository.state.HEAD?.name), {
        title: options.title,
        placeHolder: options.placeHolder,
        matchOnDescription: true
    });
    return pick?.ref;
}

async function pickRemote(repository: Repository, placeHolder: string): Promise<string | undefined> {
    const remotes = repository.state.remotes;
    if (remotes.length === 0) {
        const choice = await vscode.window.showWarningMessage(
            'This repository has no remotes.',
            'Add Remote...'
        );
        if (choice) {
            await addRemote(repository);
        }
        return undefined;
    }
    if (remotes.length === 1) {
        return remotes[0].name;
    }
    const pick = await vscode.window.showQuickPick(
        remotes.map(remote => ({ label: remote.name, description: remote.fetchUrl })),
        { placeHolder }
    );
    return pick?.label;
}

async function showText(content: string, language = 'diff'): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ content, language });
    await vscode.window.showTextDocument(document, { preview: true });
}

async function openFile(uri: vscode.Uri): Promise<void> {
    try {
        await vscode.window.showTextDocument(uri);
    } catch {
        vscode.window.showWarningMessage(`File not found: ${uri.fsPath}`);
    }
}

export function validateBranchName(value: string): string | undefined {
    const name = value.trim();
    if (!name) {
        return 'The branch name cannot be empty.';
    }
    const invalid =
        /[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) ||
        name.includes('..') ||
        name.includes('@{') ||
        name.includes('//') ||
        /(^|\/)\./.test(name) ||
        name.startsWith('-') ||
        name.startsWith('/') ||
        name.endsWith('/') ||
        name.endsWith('.') ||
        name.endsWith('.lock') ||
        name === '@';
    return invalid ? `'${name}' is not a valid branch name.` : undefined;
}

function validateRemoteName(value: string): string | undefined {
    const name = value.trim();
    if (!name) {
        return 'The remote name cannot be empty.';
    }
    return /^[\w.-]+$/.test(name) ? undefined : `'${name}' is not a valid remote name.`;
}
