import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage, execGit, GitService, runGit } from './gitService';
import { Change, Repository, Status } from './typings/git';

/*
 * Commit page modeled on Visual Studio's "Git Changes" window: multi-line
 * message, author identity, staged and unstaged changes, and the
 * Commit / Commit & Push / Stash actions. The page (media/commit.js) only
 * renders the state and posts the user's actions back.
 */

type Message =
    | { type: 'ready' | 'refresh' | 'changeAuthor' }
    | { type: 'selectRepository'; root: string }
    | { type: 'draft'; message: string }
    | { type: 'commit'; message: string; amend: boolean; push: boolean }
    | { type: 'stash'; message: string }
    | { type: 'stage' | 'unstage'; paths: string[] }
    | { type: 'open'; path: string; staged: boolean };

/** Short status letter and its description, as in the Source Control view. */
const STATUS: Partial<Record<Status, [string, string]>> = {
    [Status.INDEX_MODIFIED]: ['M', 'Modified'],
    [Status.MODIFIED]: ['M', 'Modified'],
    [Status.INDEX_ADDED]: ['A', 'Added'],
    [Status.INTENT_TO_ADD]: ['A', 'Added'],
    [Status.INDEX_DELETED]: ['D', 'Deleted'],
    [Status.DELETED]: ['D', 'Deleted'],
    [Status.INDEX_RENAMED]: ['R', 'Renamed'],
    [Status.INTENT_TO_RENAME]: ['R', 'Renamed'],
    [Status.INDEX_COPIED]: ['C', 'Copied'],
    [Status.UNTRACKED]: ['U', 'Untracked'],
    [Status.TYPE_CHANGED]: ['T', 'Type changed']
};

export class CommitPanel implements vscode.Disposable {
    private static current: CommitPanel | undefined;

    private readonly disposables: vscode.Disposable[] = [];
    private repositoryDisposable: vscode.Disposable | undefined;
    private repositoryRoot: string | undefined;
    private busy = false;

    /** Opens the page; `push` pre-selects Commit & Push as the main action. */
    static show(context: vscode.ExtensionContext, git: GitService, repository?: Repository, push = false): void {
        if (!CommitPanel.current) {
            const panel = vscode.window.createWebviewPanel(
                'gitQuickMenu.commit',
                vscode.l10n.t('Git Changes'),
                vscode.ViewColumn.Active,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
                }
            );
            CommitPanel.current = new CommitPanel(panel, context, git);
        }
        const current = CommitPanel.current;
        if (repository) {
            current.repositoryRoot = repository.rootUri.fsPath;
        }
        current.panel.reveal();
        current.panel.webview.postMessage({ type: 'focus', push });
        current.update();
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly git: GitService
    ) {
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png');
        panel.webview.html = this.html();
        this.disposables.push(
            panel.onDidDispose(() => this.dispose()),
            panel.webview.onDidReceiveMessage((message: Message) => this.handle(message)),
            git.onDidChangeRepositories(() => this.update()),
            // The identity may change in the settings page or in a terminal.
            vscode.window.onDidChangeWindowState(state => state.focused && this.update()),
            panel.onDidChangeViewState(e => e.webviewPanel.visible && this.update())
        );
    }

    dispose(): void {
        CommitPanel.current = undefined;
        this.repositoryDisposable?.dispose();
        this.disposables.forEach(d => d.dispose());
        this.panel.dispose();
    }

    private async handle(message: Message): Promise<void> {
        const repository = this.repository();
        if (message.type === 'draft') {
            // Shared with the Source Control view's message box.
            if (repository) {
                repository.inputBox.value = message.message;
            }
            return;
        }
        if (this.busy) {
            return;
        }
        this.busy = true;
        try {
            switch (message.type) {
                case 'selectRepository':
                    this.repositoryRoot = message.root;
                    break;
                case 'changeAuthor':
                    await vscode.commands.executeCommand('gitQuickMenu.settings');
                    break;
                case 'stage':
                    if (repository) {
                        await repository.add(message.paths);
                    }
                    break;
                case 'unstage':
                    if (repository) {
                        await runGit(repository, ['reset', '-q', '--', ...message.paths]);
                        await repository.status();
                    }
                    break;
                case 'open':
                    if (repository) {
                        await this.openChange(repository, message.path, message.staged);
                    }
                    break;
                case 'commit':
                    if (repository) {
                        await this.commit(repository, message.message, message.amend, message.push);
                    }
                    break;
                case 'stash':
                    if (repository) {
                        const args = ['stash', 'push', '--include-untracked'];
                        if (message.message.trim()) {
                            args.push('-m', message.message.trim());
                        }
                        await runGit(repository, args);
                        await repository.status();
                        repository.inputBox.value = '';
                        this.panel.webview.postMessage({ type: 'clear' });
                        vscode.window.setStatusBarMessage(`$(check) ${vscode.l10n.t('Changes stashed')}`, 5000);
                    }
                    break;
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Git: ${errorMessage(error)}`);
        } finally {
            this.busy = false;
        }
        await this.update();
    }

    private async commit(repository: Repository, message: string, amend: boolean, push: boolean): Promise<void> {
        const { indexChanges, workingTreeChanges, mergeChanges } = repository.state;
        if (!message.trim()) {
            vscode.window.showWarningMessage(vscode.l10n.t('Enter a message describing the commit.'));
            return;
        }
        if (!amend && indexChanges.length === 0 && workingTreeChanges.length === 0 && mergeChanges.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('There are no changes to commit.'));
            return;
        }
        // Like Visual Studio: with nothing staged, "Commit All" commits every change.
        const commitAll = indexChanges.length === 0 && !amend;
        await repository.commit(message.trim(), { all: commitAll, amend });
        repository.inputBox.value = '';
        this.panel.webview.postMessage({ type: 'clear' });
        vscode.window.setStatusBarMessage(
            `$(check) ${vscode.l10n.t('Committed: {0}', message.trim().split('\n')[0])}`,
            5000
        );
        if (push) {
            await vscode.commands.executeCommand('gitQuickMenu.push');
        }
    }

    private async openChange(repository: Repository, filePath: string, staged: boolean): Promise<void> {
        const changes = staged ? repository.state.indexChanges : repository.state.workingTreeChanges;
        const change = changes.find(c => c.uri.fsPath === filePath);
        if (!change) {
            return;
        }
        const name = path.basename(change.uri.fsPath);
        const added = change.status === Status.UNTRACKED || change.status === Status.INDEX_ADDED || change.status === Status.INTENT_TO_ADD;
        const deleted = change.status === Status.DELETED || change.status === Status.INDEX_DELETED;
        if (added) {
            await vscode.commands.executeCommand('vscode.open', staged ? this.git.toGitUri(change.uri, '') : change.uri);
            return;
        }
        // Staged: HEAD <-> index. Unstaged: index <-> working tree.
        const left = this.git.toGitUri(change.originalUri, staged ? 'HEAD' : '~');
        const right = deleted ? this.git.toGitUri(change.originalUri, staged ? 'HEAD' : '~') : staged ? this.git.toGitUri(change.uri, '') : change.uri;
        const title = staged ? vscode.l10n.t('{0} (Index)', name) : vscode.l10n.t('{0} (Working Tree)', name);
        await vscode.commands.executeCommand('vscode.diff', left, right, title);
    }

    /** The repository shown: the selected one, the one of the active editor, or the first. */
    private repository(): Repository | undefined {
        const repositories = this.git.repositories;
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const selected =
            repositories.find(r => r.rootUri.fsPath === this.repositoryRoot) ??
            repositories.find(r => activeUri && activeUri.fsPath.startsWith(r.rootUri.fsPath)) ??
            repositories[0];
        if (selected?.rootUri.fsPath !== this.repositoryRoot || !this.repositoryDisposable) {
            this.repositoryDisposable?.dispose();
            this.repositoryDisposable = selected?.state.onDidChange(() => this.update());
        }
        this.repositoryRoot = selected?.rootUri.fsPath;
        return selected;
    }

    private async update(): Promise<void> {
        const repository = this.repository();
        if (!repository) {
            this.panel.webview.postMessage({ type: 'state', repositories: [] });
            return;
        }
        const root = repository.rootUri.fsPath;
        const [name, email] = await Promise.all([
            execGit(['config', 'user.name'], root).then(v => v.trim(), () => ''),
            execGit(['config', 'user.email'], root).then(v => v.trim(), () => '')
        ]);
        const toItem = (change: Change) => {
            const [letter, description] = STATUS[change.status] ?? ['!', 'Conflict'];
            const relative = path.relative(root, change.uri.fsPath);
            return {
                path: change.uri.fsPath,
                name: path.basename(relative),
                folder: path.dirname(relative) === '.' ? '' : path.dirname(relative),
                letter,
                description: vscode.l10n.t(description)
            };
        };
        const head = repository.state.HEAD;
        this.panel.webview.postMessage({
            type: 'state',
            repositories: this.git.repositories.map(r => ({ root: r.rootUri.fsPath, name: path.basename(r.rootUri.fsPath) })),
            repository: root,
            branch: head?.name ?? head?.commit?.slice(0, 7) ?? '',
            ahead: head?.ahead ?? 0,
            behind: head?.behind ?? 0,
            author: { name, email },
            draft: repository.inputBox.value,
            staged: repository.state.indexChanges.map(toItem),
            changes: [...repository.state.mergeChanges, ...repository.state.workingTreeChanges].map(toItem)
        });
    }

    private html(): string {
        const webview = this.panel.webview;
        const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
        const nonce = crypto.randomBytes(16).toString('base64');
        const init = { strings: strings() };
        const initJson = JSON.stringify(init).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('settings.css')}">
<link rel="stylesheet" href="${media('commit.css')}">
<title>${vscode.l10n.t('Git Changes')}</title>
</head>
<body>
<main id="root"></main>
<script nonce="${nonce}" id="init" type="application/json">${initJson}</script>
<script nonce="${nonce}" src="${media('commit.js')}"></script>
</body>
</html>`;
    }
}

/** Static texts of the page. */
function strings(): Record<string, string> {
    return {
        title: vscode.l10n.t('Git Changes'),
        repository: vscode.l10n.t('Repository'),
        branch: vscode.l10n.t('Branch'),
        author: vscode.l10n.t('Author'),
        noAuthor: vscode.l10n.t('No name or email configured'),
        changeAuthor: vscode.l10n.t('Change...'),
        messagePlaceholder: vscode.l10n.t('Enter a message\n\nThe first line is the summary; add a description after a blank line.'),
        amend: vscode.l10n.t('Amend previous commit'),
        commitAll: vscode.l10n.t('Commit All'),
        commitStaged: vscode.l10n.t('Commit Staged'),
        commitAndPush: vscode.l10n.t('Commit and Push'),
        amendCommit: vscode.l10n.t('Amend Commit'),
        stashAll: vscode.l10n.t('Stash All'),
        staged: vscode.l10n.t('Staged Changes'),
        changes: vscode.l10n.t('Changes'),
        stage: vscode.l10n.t('Stage'),
        unstage: vscode.l10n.t('Unstage'),
        stageAll: vscode.l10n.t('Stage All'),
        unstageAll: vscode.l10n.t('Unstage All'),
        noChanges: vscode.l10n.t('No changes.'),
        noRepository: vscode.l10n.t('No Git repository is open in this workspace.'),
        refresh: vscode.l10n.t('Refresh'),
        outgoing: vscode.l10n.t('{0} outgoing'),
        incoming: vscode.l10n.t('{0} incoming'),
        shortcut: vscode.l10n.t('Ctrl+Enter to commit')
    };
}
