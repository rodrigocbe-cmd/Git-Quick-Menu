import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { errorMessage, GitService, runGit } from './gitService';
import { CommitPanel } from './commitPanel';
import { SettingsPanel } from './settingsPanel';
import { Ref, RefType, Repository } from './typings/git';

type RepositoryCommand = (repository: Repository) => Promise<unknown>;

export function registerCommands(context: vscode.ExtensionContext, git: GitService): void {
    const repositoryCommands: Record<string, RepositoryCommand> = {
        'gitQuickMenu.newBranch': newBranch,
        'gitQuickMenu.checkout': checkout,
        'gitQuickMenu.commit': async repository => CommitPanel.show(context, git, repository),
        'gitQuickMenu.commitAndPush': async repository => CommitPanel.show(context, git, repository, true),
        'gitQuickMenu.pull': pull,
        'gitQuickMenu.push': push,
        'gitQuickMenu.fetch': fetch,
        'gitQuickMenu.sync': sync,
        'gitQuickMenu.manageBranches': manageBranches,
        'gitQuickMenu.manageRemotes': manageRemotes,
        'gitQuickMenu.stash': stash,
        'gitQuickMenu.log': log,
        'gitQuickMenu.github': github,
        'gitQuickMenu.openOnGitHub': repository => openGitHub(repository, 'tree'),
        'gitQuickMenu.createPullRequest': repository => openGitHub(repository, 'compare'),
        'gitQuickMenu.viewPullRequests': repository => openGitHub(repository, 'pulls'),
        'gitQuickMenu.viewIssues': repository => openGitHub(repository, 'issues'),
        'gitQuickMenu.openInFileExplorer': async repository => vscode.env.openExternal(repository.rootUri),
        'gitQuickMenu.openInCommandPrompt': openInCommandPrompt
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
        vscode.commands.registerCommand('gitQuickMenu.settings', () => SettingsPanel.show(context, git)),
        vscode.commands.registerCommand('gitQuickMenu.clone', () => vscode.commands.executeCommand('git.clone')),
        vscode.commands.registerCommand('gitQuickMenu.openRepository', () =>
            vscode.commands.executeCommand('git.openRepository')
        ),
        vscode.commands.registerCommand('gitQuickMenu.localRepositories', () => guarded(localRepositories)),
        // Same as Visual Studio, which opens its "Git Changes" window.
        vscode.commands.registerCommand('gitQuickMenu.commitOrStash', () => CommitPanel.show(context, git))
    );
}

/** Quick Pick counterpart of the "Local Repositories" submenu. */
async function localRepositories(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
        [
            { label: `$(folder-opened) ${vscode.l10n.t('Open Local Repository...')}`, command: 'git.openRepository' },
            { label: `$(history) ${vscode.l10n.t('Open Recent...')}`, command: 'workbench.action.openRecent' },
            { label: `$(repo) ${vscode.l10n.t('Initialize Repository')}`, command: 'git.init' }
        ],
        { title: vscode.l10n.t('Local Repositories') }
    );
    if (pick) {
        await vscode.commands.executeCommand(pick.command);
    }
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
        title: vscode.l10n.t('New Branch (1/2): Based on'),
        placeHolder: vscode.l10n.t('Select the branch the new branch will be based on'),
        includeRemote: true
    });
    if (!base?.name) {
        return;
    }
    const name = await vscode.window.showInputBox({
        title: vscode.l10n.t('New Branch (2/2): Name'),
        prompt: vscode.l10n.t("Create a new branch from '{0}' and check it out", base.name),
        placeHolder: 'feature/my-branch',
        validateInput: validateBranchName
    });
    if (!name) {
        return;
    }
    await repository.createBranch(name.trim(), true, base.name);
    vscode.window.showInformationMessage(vscode.l10n.t("Switched to new branch '{0}'.", name.trim()));
}

async function checkout(repository: Repository): Promise<void> {
    const ref = await pickBranch(repository, {
        title: vscode.l10n.t('Checkout'),
        placeHolder: vscode.l10n.t('Select a branch to check out'),
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
        { label: `$(add) ${vscode.l10n.t('New Branch...')}`, create: true },
        ...branchItems(refs, current)
    ];
    const pick = await vscode.window.showQuickPick<Item>(items, {
        title: vscode.l10n.t('Manage Branches'),
        placeHolder: vscode.l10n.t('Select a branch'),
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
        actions.push({ id: 'checkout', label: `$(git-branch) ${vscode.l10n.t('Checkout')}` });
        if (current) {
            actions.push({ id: 'merge', label: `$(git-merge) ${vscode.l10n.t("Merge into '{0}'", current)}` });
        }
    }
    if (isLocal) {
        actions.push({ id: 'rename', label: `$(edit) ${vscode.l10n.t('Rename...')}` });
        if (!isCurrent) {
            actions.push({ id: 'delete', label: `$(trash) ${vscode.l10n.t('Delete')}` });
        }
    }
    actions.push({ id: 'copy', label: `$(copy) ${vscode.l10n.t('Copy Branch Name')}` });

    const action = await vscode.window.showQuickPick(actions, { title: vscode.l10n.t("Branch '{0}'", name) });
    switch (action?.id) {
        case 'checkout':
            return checkoutRef(repository, ref);
        case 'merge':
            const commitAfterMerge = vscode.workspace
                .getConfiguration('gitQuickMenu')
                .get<boolean>('commitAfterMerge', true);
            await withProgress(vscode.l10n.t("Merging '{0}' into '{1}'...", name, current!), () =>
                runGit(repository, commitAfterMerge ? ['merge', name] : ['merge', '--no-commit', '--no-ff', name])
            );
            await repository.status();
            if (commitAfterMerge) {
                vscode.window.showInformationMessage(vscode.l10n.t("Merged '{0}' into '{1}'.", name, current!));
            } else {
                vscode.window.showInformationMessage(
                    vscode.l10n.t("Merged '{0}' into '{1}' without committing. Review the changes and commit them.", name, current!)
                );
                await vscode.commands.executeCommand('workbench.view.scm');
            }
            return;
        case 'rename': {
            const newName = await vscode.window.showInputBox({
                title: vscode.l10n.t("Rename Branch '{0}'", name),
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
    const deleteLabel = vscode.l10n.t('Delete');
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Delete branch '{0}'?", name),
        { modal: true },
        deleteLabel
    );
    if (confirm !== deleteLabel) {
        return;
    }
    try {
        await repository.deleteBranch(name, false);
    } catch (error) {
        const forceLabel = vscode.l10n.t('Force Delete');
        const force = await vscode.window.showWarningMessage(
            vscode.l10n.t("Branch '{0}' could not be deleted: {1}", name, errorMessage(error)),
            { modal: true },
            forceLabel
        );
        if (force === forceLabel) {
            await repository.deleteBranch(name, true);
        }
    }
}

// ---------------------------------------------------------------- commit / sync

async function pull(repository: Repository): Promise<void> {
    const head = repository.state.HEAD;
    if (!head?.upstream) {
        vscode.window.showWarningMessage(
            head?.name
                ? vscode.l10n.t("Branch '{0}' has no upstream branch. Push it first to publish it.", head.name)
                : vscode.l10n.t('Cannot pull: HEAD is detached.')
        );
        return;
    }
    await withProgress(vscode.l10n.t("Pulling '{0}'...", head.name!), () => repository.pull());
    vscode.window.setStatusBarMessage(`$(check) ${vscode.l10n.t('Pull complete')}`, 5000);
}

async function push(repository: Repository): Promise<void> {
    const head = repository.state.HEAD;
    if (!head?.name) {
        vscode.window.showWarningMessage(vscode.l10n.t('Cannot push: HEAD is detached.'));
        return;
    }
    if (head.upstream) {
        await withProgress(vscode.l10n.t("Pushing '{0}'...", head.name), () => repository.push());
    } else {
        const remote = await pickRemote(repository, vscode.l10n.t("Select a remote to publish '{0}' to", head.name));
        if (!remote) {
            return;
        }
        await withProgress(vscode.l10n.t("Publishing '{0}' to '{1}'...", head.name, remote), () =>
            repository.push(remote, head.name, true)
        );
    }
    vscode.window.setStatusBarMessage(`$(check) ${vscode.l10n.t('Push complete')}`, 5000);
}

async function fetch(repository: Repository): Promise<void> {
    if (repository.state.remotes.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t('This repository has no remotes to fetch from.'));
        return;
    }
    await withProgress(vscode.l10n.t('Fetching...'), () => repository.fetch({ all: true }));
    vscode.window.setStatusBarMessage(`$(check) ${vscode.l10n.t('Fetch complete')}`, 5000);
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
        { label: `$(add) ${vscode.l10n.t('Add Remote...')}` },
        ...repository.state.remotes.map(remote => ({
            label: `$(remote) ${remote.name}`,
            description: remote.fetchUrl ?? remote.pushUrl,
            remote: remote.name
        }))
    ];
    const pick = await vscode.window.showQuickPick<Item>(items, {
        title: vscode.l10n.t('Manage Remotes'),
        placeHolder: vscode.l10n.t('Select a remote')
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
            { id: 'fetch', label: `$(cloud-download) ${vscode.l10n.t('Fetch')}` },
            { id: 'url', label: `$(link) ${vscode.l10n.t('Change URL...')}` },
            { id: 'rename', label: `$(edit) ${vscode.l10n.t('Rename...')}` },
            { id: 'copy', label: `$(copy) ${vscode.l10n.t('Copy URL')}` },
            { id: 'remove', label: `$(trash) ${vscode.l10n.t('Remove')}` }
        ],
        { title: vscode.l10n.t("Remote '{0}'", name) }
    );
    switch (action?.id) {
        case 'fetch':
            await withProgress(vscode.l10n.t("Fetching '{0}'...", name), () => repository.fetch({ remote: name }));
            return;
        case 'url': {
            const newUrl = await vscode.window.showInputBox({ title: vscode.l10n.t("URL of '{0}'", name), value: url });
            if (newUrl && newUrl.trim() !== url) {
                await runGit(repository, ['remote', 'set-url', name, newUrl.trim()]);
                await repository.status();
            }
            return;
        }
        case 'rename': {
            const newName = await vscode.window.showInputBox({
                title: vscode.l10n.t("Rename Remote '{0}'", name),
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
            const removeLabel = vscode.l10n.t('Remove');
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t("Remove remote '{0}'?", name),
                { modal: true },
                removeLabel
            );
            if (confirm === removeLabel) {
                await repository.removeRemote(name);
            }
            return;
        }
    }
}

async function addRemote(repository: Repository): Promise<void> {
    const name = await vscode.window.showInputBox({
        title: vscode.l10n.t('Add Remote (1/2): Name'),
        value: repository.state.remotes.length === 0 ? 'origin' : '',
        validateInput: validateRemoteName
    });
    if (!name) {
        return;
    }
    const url = await vscode.window.showInputBox({
        title: vscode.l10n.t('Add Remote (2/2): URL'),
        placeHolder: 'https://github.com/user/repo.git',
        validateInput: value => (value.trim() ? undefined : vscode.l10n.t('The URL cannot be empty.'))
    });
    if (!url) {
        return;
    }
    await repository.addRemote(name.trim(), url.trim());
    vscode.window.showInformationMessage(vscode.l10n.t("Remote '{0}' added.", name.trim()));
}

// ---------------------------------------------------------------- stash

async function stash(repository: Repository): Promise<void> {
    const action = await vscode.window.showQuickPick(
        [
            { id: 'push', label: `$(archive) ${vscode.l10n.t('Stash Changes...')}` },
            { id: 'pushUntracked', label: `$(archive) ${vscode.l10n.t('Stash All (Include Untracked)...')}` },
            { id: 'pop', label: `$(inbox) ${vscode.l10n.t('Pop Stash...')}` },
            { id: 'apply', label: `$(inbox) ${vscode.l10n.t('Apply Stash...')}` },
            { id: 'show', label: `$(eye) ${vscode.l10n.t('View Stash...')}` },
            { id: 'drop', label: `$(trash) ${vscode.l10n.t('Drop Stash...')}` }
        ],
        { title: vscode.l10n.t('Stash') }
    );
    if (!action) {
        return;
    }

    if (action.id === 'push' || action.id === 'pushUntracked') {
        const message = await vscode.window.showInputBox({
            title: vscode.l10n.t('Stash'),
            placeHolder: vscode.l10n.t('Stash message (optional)')
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
        const dropLabel = vscode.l10n.t('Drop');
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t('Drop {0}? This cannot be undone.', ref),
            { modal: true },
            dropLabel
        );
        if (confirm !== dropLabel) {
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
        vscode.window.showInformationMessage(vscode.l10n.t('There are no stashes.'));
        return undefined;
    }
    const pick = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t('Select a Stash'),
        matchOnDescription: true
    });
    return pick?.label;
}

// ---------------------------------------------------------------- log

async function log(repository: Repository): Promise<void> {
    const maxEntries = vscode.workspace.getConfiguration('gitQuickMenu').get<number>('logMaxEntries', 100);
    const commits = await repository.log({ maxEntries });
    if (commits.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('This repository has no commits yet.'));
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
            title: vscode.l10n.t('Git Log: {0}', repository.state.HEAD?.name ?? 'HEAD'),
            placeHolder: vscode.l10n.t('Select a commit to view its changes'),
            matchOnDescription: true,
            matchOnDetail: true
        }
    );
    if (pick) {
        await showText(await runGit(repository, ['show', '--stat', '--patch', pick.hash]));
    }
}

// ---------------------------------------------------------------- GitHub

type GitHubPage = 'tree' | 'compare' | 'pulls' | 'issues';

/** Quick Pick counterpart of the "GitHub" submenu. */
async function github(repository: Repository): Promise<void> {
    const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { page: GitHubPage }>(
        [
            { label: `$(github) ${vscode.l10n.t('Open on GitHub')}`, page: 'tree' },
            { label: `$(git-pull-request-create) ${vscode.l10n.t('Create Pull Request')}`, page: 'compare' },
            { label: `$(git-pull-request) ${vscode.l10n.t('View Pull Requests')}`, page: 'pulls' },
            { label: `$(issues) ${vscode.l10n.t('View Issues')}`, page: 'issues' }
        ],
        { title: 'GitHub' }
    );
    if (pick) {
        await openGitHub(repository, pick.page);
    }
}

async function openGitHub(repository: Repository, page: GitHubPage): Promise<void> {
    const remotes = repository.state.remotes
        .map(remote => ({ name: remote.name, url: gitHubUrl(remote.fetchUrl ?? remote.pushUrl) }))
        .filter((remote): remote is { name: string; url: string } => remote.url !== undefined);
    if (remotes.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t('This repository has no GitHub remote.'));
        return;
    }
    const upstreamRemote = repository.state.HEAD?.upstream?.remote;
    const remote =
        remotes.find(r => r.name === upstreamRemote) ?? remotes.find(r => r.name === 'origin') ?? remotes[0];
    const branch = encodeURIComponent(repository.state.HEAD?.name ?? '').replace(/%2F/g, '/');
    if (page === 'compare' && !branch) {
        vscode.window.showWarningMessage(vscode.l10n.t('Check out a branch to create a pull request.'));
        return;
    }
    const suffix =
        page === 'tree' ? (branch ? `/tree/${branch}` : '') :
        page === 'compare' ? `/compare/${branch}?expand=1` :
        `/${page}`;
    await vscode.env.openExternal(vscode.Uri.parse(remote.url + suffix));
}

/** Converts an HTTPS or SSH GitHub remote URL to the repository's web URL. */
function gitHubUrl(remoteUrl: string | undefined): string | undefined {
    const match = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(remoteUrl ?? '');
    return match ? `https://github.com/${match[1]}/${match[2]}` : undefined;
}

// ---------------------------------------------------------------- open

/** Opens an external terminal in the repository root (the one set in `terminal.external.*`). */
async function openInCommandPrompt(repository: Repository): Promise<void> {
    const cwd = repository.rootUri.fsPath;
    const external = vscode.workspace.getConfiguration('terminal.external');
    let child;
    if (process.platform === 'win32') {
        const exec = external.get<string>('windowsExec') || 'cmd.exe';
        child = spawn('cmd.exe', ['/c', 'start', '""', exec], { cwd, detached: true, windowsVerbatimArguments: true });
    } else if (process.platform === 'darwin') {
        child = spawn('open', ['-a', external.get<string>('osxExec') || 'Terminal.app', cwd], { detached: true });
    } else {
        child = spawn(external.get<string>('linuxExec') || 'x-terminal-emulator', [], { cwd, detached: true });
    }
    child.on('error', error => vscode.window.showErrorMessage(`Git: ${errorMessage(error)}`));
    child.unref();
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
        description: [ref.name === current && ref.type === RefType.Head ? vscode.l10n.t('current') : '', ref.commit?.slice(0, 7)]
            .filter(Boolean)
            .join(' · '),
        ref
    });
    // Current branch first.
    local.sort((a, b) => Number(b.name === current) - Number(a.name === current));
    const items: (vscode.QuickPickItem & { ref?: Ref })[] = [];
    if (local.length) {
        items.push({ label: vscode.l10n.t('Local branches'), kind: vscode.QuickPickItemKind.Separator });
        items.push(...local.map(ref => toItem(ref, 'git-branch')));
    }
    if (remote.length) {
        items.push({ label: vscode.l10n.t('Remote branches'), kind: vscode.QuickPickItemKind.Separator });
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
            vscode.l10n.t('This repository has no remotes.'),
            vscode.l10n.t('Add Remote...')
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

export function validateBranchName(value: string): string | undefined {
    const name = value.trim();
    if (!name) {
        return vscode.l10n.t('The branch name cannot be empty.');
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
    return invalid ? vscode.l10n.t("'{0}' is not a valid branch name.", name) : undefined;
}

function validateRemoteName(value: string): string | undefined {
    const name = value.trim();
    if (!name) {
        return vscode.l10n.t('The remote name cannot be empty.');
    }
    return /^[\w.-]+$/.test(name) ? undefined : vscode.l10n.t("'{0}' is not a valid remote name.", name);
}
