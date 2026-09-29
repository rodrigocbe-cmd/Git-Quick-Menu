import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage, execGit, GitService } from './gitService';
import { Repository } from './typings/git';

/*
 * Settings page modeled on Visual Studio's "Git Settings": extension and
 * VS Code Git settings, plus the global and repository git config.
 * The page (media/settings.js) renders the sections described by `schema()`
 * and sends every change back as a message.
 */

type Scope = 'vscode' | 'global' | 'local';

interface Option {
    value: unknown;
    label: string;
}

interface Field {
    key: string;
    label: string;
    description?: string;
    type: 'text' | 'number' | 'checkbox' | 'select' | 'folder';
    options?: Option[];
    placeholder?: string;
}

interface Section {
    id: string;
    scope: Scope;
    title: string;
    description?: string;
    fields: Field[];
}

type Message =
    | { type: 'ready' | 'refresh' }
    | { type: 'setSetting'; key: string; value: unknown }
    | { type: 'setGitConfig'; scope: 'global' | 'local'; key: string; value: string }
    | { type: 'browseFolder'; key: string }
    | { type: 'selectRepository'; root: string }
    | { type: 'command'; id: string; name?: string };

const GLOBAL_KEYS = [
    'user.name',
    'user.email',
    'init.defaultBranch',
    'fetch.prune',
    'pull.rebase',
    'http.sslBackend',
    'credential.helper',
    'diff.tool',
    'merge.tool'
];
const LOCAL_KEYS = ['user.name', 'user.email', 'fetch.prune', 'pull.rebase', 'core.commitGraph', 'diff.tool', 'merge.tool'];

/** Commands that make VS Code the diff and merge tool, set along with `diff.tool` / `merge.tool` = vscode. */
const VSCODE_TOOL_COMMANDS: Record<string, [string, string]> = {
    'diff.tool': ['difftool.vscode.cmd', 'code --wait --diff "$LOCAL" "$REMOTE"'],
    'merge.tool': ['mergetool.vscode.cmd', 'code --wait --merge "$REMOTE" "$LOCAL" "$BASE" "$MERGED"']
};

export class SettingsPanel implements vscode.Disposable {
    private static current: SettingsPanel | undefined;

    private readonly disposables: vscode.Disposable[] = [];
    private repositoryRoot: string | undefined;

    static show(context: vscode.ExtensionContext, git: GitService): void {
        if (SettingsPanel.current) {
            SettingsPanel.current.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'gitQuickMenu.settings',
            vscode.l10n.t('Git Settings'),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            }
        );
        SettingsPanel.current = new SettingsPanel(panel, context, git);
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
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('git') || e.affectsConfiguration('gitQuickMenu')) {
                    this.update();
                }
            }),
            git.onDidChangeRepositories(() => this.update())
        );
    }

    dispose(): void {
        SettingsPanel.current = undefined;
        this.disposables.forEach(d => d.dispose());
        this.panel.dispose();
    }

    private async handle(message: Message): Promise<void> {
        try {
            switch (message.type) {
                case 'ready':
                case 'refresh':
                    break;
                case 'setSetting':
                    await this.setSetting(message.key, message.value);
                    break;
                case 'setGitConfig':
                    await this.setGitConfig(message.scope, message.key, message.value);
                    break;
                case 'browseFolder': {
                    const folder = await vscode.window.showOpenDialog({
                        canSelectFolders: true,
                        canSelectFiles: false,
                        canSelectMany: false
                    });
                    if (folder) {
                        await this.setSetting(message.key, folder[0].fsPath);
                    }
                    break;
                }
                case 'selectRepository':
                    this.repositoryRoot = message.root;
                    break;
                case 'command':
                    await this.runCommand(message.id, message.name);
                    break;
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Git: ${errorMessage(error)}`);
        }
        await this.update();
    }

    private async setSetting(key: string, value: unknown): Promise<void> {
        const dot = key.indexOf('.');
        const configuration = vscode.workspace.getConfiguration(key.slice(0, dot));
        const name = key.slice(dot + 1);
        // The main menu bar has its own commands, which ask for confirmation.
        if (key === 'gitQuickMenu.mainMenuBar') {
            await vscode.commands.executeCommand(value ? 'gitQuickMenu.enableMainMenuBar' : 'gitQuickMenu.disableMainMenuBar');
            return;
        }
        await configuration.update(name, value, vscode.ConfigurationTarget.Global);
    }

    private async setGitConfig(scope: 'global' | 'local', key: string, value: string): Promise<void> {
        const cwd = scope === 'local' ? this.repositoryRoot : undefined;
        if (scope === 'local' && !cwd) {
            return;
        }
        const set = (k: string, v: string) =>
            v.trim() ? execGit(['config', `--${scope}`, k, v.trim()], cwd) : unset(k);
        const unset = (k: string) =>
            // Exit code 5: the key was not set.
            execGit(['config', `--${scope}`, '--unset-all', k], cwd).catch(() => undefined);

        await set(key, value);
        if (key === 'core.commitGraph') {
            await set('fetch.writeCommitGraph', value);
        }
        const toolCommand = VSCODE_TOOL_COMMANDS[key];
        if (toolCommand && value === 'vscode' && !(await getConfig(scope, toolCommand[0], cwd))) {
            await set(toolCommand[0], toolCommand[1]);
        }
        const repository = this.repository();
        if (repository) {
            await repository.status();
        }
    }

    private async runCommand(id: string, name?: string): Promise<void> {
        const repository = this.repository();
        const root = repository?.rootUri;
        switch (id) {
            case 'openGlobalConfig': {
                const file = path.join(process.env.HOME || os.homedir(), '.gitconfig');
                await vscode.window.showTextDocument(vscode.Uri.file(file));
                return;
            }
            case 'openRepositoryConfig':
                if (root) {
                    const configPath = (await execGit(['rev-parse', '--git-path', 'config'], root.fsPath)).trim();
                    await vscode.window.showTextDocument(
                        path.isAbsolute(configPath) ? vscode.Uri.file(configPath) : vscode.Uri.joinPath(root, configPath)
                    );
                }
                return;
            case 'openRepositoryFolder':
                if (root) {
                    await vscode.env.openExternal(root);
                }
                return;
            case 'editGitignore':
            case 'editGitattributes':
                if (root) {
                    const file = vscode.Uri.joinPath(root, id === 'editGitignore' ? '.gitignore' : '.gitattributes');
                    try {
                        await vscode.workspace.fs.stat(file);
                    } catch {
                        await vscode.workspace.fs.writeFile(file, new Uint8Array());
                    }
                    await vscode.window.showTextDocument(file);
                }
                return;
            case 'openVsCodeSettings':
                await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vscode.git');
                return;
            case 'addRemote':
            case 'editRemote':
                if (repository) {
                    await this.editRemote(repository, id === 'editRemote' ? name : undefined);
                }
                return;
            case 'removeRemote':
                if (repository && name) {
                    const removeLabel = vscode.l10n.t('Remove');
                    const confirm = await vscode.window.showWarningMessage(
                        vscode.l10n.t("Remove remote '{0}'?", name),
                        { modal: true },
                        removeLabel
                    );
                    if (confirm === removeLabel) {
                        await repository.removeRemote(name);
                    }
                }
                return;
        }
    }

    /** Adds a remote, or edits the name and URL of `current`. */
    private async editRemote(repository: Repository, current?: string): Promise<void> {
        const remote = repository.state.remotes.find(r => r.name === current);
        const newName = await vscode.window.showInputBox({
            title: current ? vscode.l10n.t("Rename Remote '{0}'", current) : vscode.l10n.t('Add Remote (1/2): Name'),
            value: current ?? (repository.state.remotes.length === 0 ? 'origin' : ''),
            validateInput: value =>
                !value.trim()
                    ? vscode.l10n.t('The remote name cannot be empty.')
                    : /^[\w.-]+$/.test(value.trim())
                      ? undefined
                      : vscode.l10n.t("'{0}' is not a valid remote name.", value.trim())
        });
        if (!newName) {
            return;
        }
        const oldUrl = remote?.fetchUrl ?? remote?.pushUrl ?? '';
        const url = await vscode.window.showInputBox({
            title: current ? vscode.l10n.t("URL of '{0}'", current) : vscode.l10n.t('Add Remote (2/2): URL'),
            value: oldUrl,
            placeHolder: 'https://github.com/user/repo.git',
            validateInput: value => (value.trim() ? undefined : vscode.l10n.t('The URL cannot be empty.'))
        });
        if (!url) {
            return;
        }
        const cwd = repository.rootUri.fsPath;
        if (!current) {
            await repository.addRemote(newName.trim(), url.trim());
            return;
        }
        if (newName.trim() !== current) {
            await execGit(['remote', 'rename', current, newName.trim()], cwd);
        }
        if (url.trim() !== oldUrl) {
            await execGit(['remote', 'set-url', newName.trim(), url.trim()], cwd);
        }
        await repository.status();
    }

    /** The repository shown in "Git Repository Config": the selected one, or the first. */
    private repository(): Repository | undefined {
        const repositories = this.git.repositories;
        const selected = repositories.find(r => r.rootUri.fsPath === this.repositoryRoot) ?? repositories[0];
        this.repositoryRoot = selected?.rootUri.fsPath;
        return selected;
    }

    private async update(): Promise<void> {
        const repository = this.repository();
        const root = repository?.rootUri.fsPath;
        const vscodeValues: Record<string, unknown> = {};
        for (const section of schema()) {
            if (section.scope === 'vscode') {
                for (const field of section.fields) {
                    vscodeValues[field.key] = vscode.workspace.getConfiguration().get(field.key);
                }
            }
        }
        const [version, global, local] = await Promise.all([
            execGit(['--version']).catch(() => ''),
            readConfig('global', GLOBAL_KEYS),
            root ? readConfig('local', LOCAL_KEYS, root) : Promise.resolve({})
        ]);
        this.panel.webview.postMessage({
            type: 'state',
            gitVersion: version.trim(),
            values: { vscode: vscodeValues, global, local },
            repositories: this.git.repositories.map(r => ({
                root: r.rootUri.fsPath,
                name: path.basename(r.rootUri.fsPath)
            })),
            repository: root,
            remotes: (repository?.state.remotes ?? []).map(r => ({
                name: r.name,
                fetchUrl: r.fetchUrl ?? '',
                pushUrl: r.pushUrl ?? r.fetchUrl ?? ''
            }))
        });
    }

    private html(): string {
        const webview = this.panel.webview;
        const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
        const nonce = crypto.randomBytes(16).toString('base64');
        const init = { sections: schema(), strings: strings() };
        // Embedded as JSON in a script tag; "<" is escaped so values cannot close the tag.
        const initJson = JSON.stringify(init).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('settings.css')}">
<title>${vscode.l10n.t('Git Settings')}</title>
</head>
<body>
<main id="root"></main>
<script nonce="${nonce}" id="init" type="application/json">${initJson}</script>
<script nonce="${nonce}" src="${media('settings.js')}"></script>
</body>
</html>`;
    }
}

async function getConfig(scope: 'global' | 'local', key: string, cwd?: string): Promise<string | undefined> {
    try {
        return (await execGit(['config', `--${scope}`, '--get', key], cwd)).trim() || undefined;
    } catch {
        return undefined;
    }
}

async function readConfig(scope: 'global' | 'local', keys: string[], cwd?: string): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    await Promise.all(
        keys.map(async key => {
            const value = await getConfig(scope, key, cwd);
            if (value !== undefined) {
                values[key] = value;
            }
        })
    );
    return values;
}

function yesNo(): Option[] {
    return [
        { value: 'true', label: vscode.l10n.t('True') },
        { value: 'false', label: vscode.l10n.t('False') }
    ];
}

function gitConfigFields(scope: 'global' | 'local'): Field[] {
    const tool: Option[] = [{ value: 'vscode', label: 'Visual Studio Code' }];
    const fields: Field[] = [
        { key: 'user.name', label: vscode.l10n.t('User name'), type: 'text' },
        { key: 'user.email', label: vscode.l10n.t('Email'), type: 'text' }
    ];
    if (scope === 'global') {
        fields.push({ key: 'init.defaultBranch', label: vscode.l10n.t('Default branch name'), type: 'text', placeholder: 'main' });
    }
    fields.push(
        { key: 'fetch.prune', label: vscode.l10n.t('Prune remote branches during fetch'), type: 'select', options: yesNo() },
        {
            key: 'pull.rebase',
            label: vscode.l10n.t('Rebase local branch when pulling'),
            type: 'select',
            options: [
                ...yesNo(),
                { value: 'merges', label: vscode.l10n.t('Merges') },
                { value: 'interactive', label: vscode.l10n.t('Interactive') }
            ]
        }
    );
    if (scope === 'global') {
        fields.push(
            {
                key: 'http.sslBackend',
                label: vscode.l10n.t('Cryptographic network provider'),
                type: 'select',
                options: [
                    { value: 'openssl', label: 'OpenSSL' },
                    { value: 'schannel', label: 'Secure Channel' }
                ]
            },
            {
                key: 'credential.helper',
                label: vscode.l10n.t('Credential helper'),
                type: 'select',
                options: [{ value: 'manager', label: 'Git Credential Manager' }]
            }
        );
    } else {
        fields.push({
            key: 'core.commitGraph',
            label: vscode.l10n.t('Enable commit graph for better Git performance'),
            description: vscode.l10n.t('Also writes the commit graph on fetch (fetch.writeCommitGraph).'),
            type: 'select',
            options: yesNo()
        });
    }
    fields.push(
        { key: 'diff.tool', label: vscode.l10n.t('Diff Tool'), type: 'select', options: tool },
        { key: 'merge.tool', label: vscode.l10n.t('Merge Tool'), type: 'select', options: tool }
    );
    return fields;
}

function schema(): Section[] {
    return [
        {
            id: 'extension',
            scope: 'vscode',
            title: vscode.l10n.t('Git Settings'),
            fields: [
                {
                    key: 'git.defaultCloneDirectory',
                    label: vscode.l10n.t('Default location'),
                    description: vscode.l10n.t('Folder where repositories are cloned.'),
                    type: 'folder'
                },
                {
                    key: 'git.autoRepositoryDetection',
                    label: vscode.l10n.t('Automatically detect repositories'),
                    description: vscode.l10n.t('Which folders are scanned for Git repositories.'),
                    type: 'select',
                    options: [
                        { value: true, label: vscode.l10n.t('Workspace folders and subfolders') },
                        { value: 'subFolders', label: vscode.l10n.t('Subfolders of the workspace') },
                        { value: 'openEditors', label: vscode.l10n.t('Folders of open files') },
                        { value: false, label: vscode.l10n.t('Disabled') }
                    ]
                },
                { key: 'git.detectSubmodules', label: vscode.l10n.t('Automatically activate submodules'), type: 'checkbox' },
                { key: 'gitQuickMenu.commitAfterMerge', label: vscode.l10n.t('Commit changes after merge by default'), type: 'checkbox' },
                { key: 'git.useForcePushWithLease', label: vscode.l10n.t('Enable push --force-with-lease'), type: 'checkbox' },
                { key: 'git.allowForcePush', label: vscode.l10n.t('Allow force push'), type: 'checkbox' },
                { key: 'git.autofetch', label: vscode.l10n.t('Fetch periodically in the background'), type: 'checkbox' },
                { key: 'git.pruneOnFetch', label: vscode.l10n.t('Prune when fetching'), type: 'checkbox' },
                { key: 'git.rebaseWhenSync', label: vscode.l10n.t('Rebase instead of merge when syncing'), type: 'checkbox' },
                { key: 'git.confirmSync', label: vscode.l10n.t('Confirm before syncing'), type: 'checkbox' },
                {
                    key: 'git.enableSmartCommit',
                    label: vscode.l10n.t('Commit all changes when there are no staged changes'),
                    type: 'checkbox'
                }
            ]
        },
        {
            id: 'menu',
            scope: 'vscode',
            title: vscode.l10n.t('Git Menu'),
            fields: [
                {
                    key: 'gitQuickMenu.mainMenuBar',
                    label: vscode.l10n.t('Show Git in the main menu bar'),
                    description: vscode.l10n.t('Modifies a file of the VS Code installation. Requires reloading the window.'),
                    type: 'checkbox'
                },
                { key: 'gitQuickMenu.showStatusBarItem', label: vscode.l10n.t('Show Git in the status bar'), type: 'checkbox' },
                { key: 'gitQuickMenu.showInEditorTitle', label: vscode.l10n.t('Show Git in the editor title bar'), type: 'checkbox' },
                { key: 'gitQuickMenu.showInSourceControl', label: vscode.l10n.t('Show Git in the Source Control view'), type: 'checkbox' },
                { key: 'gitQuickMenu.logMaxEntries', label: vscode.l10n.t('Commits listed in View Branch History'), type: 'number' }
            ]
        },
        {
            id: 'global',
            scope: 'global',
            title: vscode.l10n.t('Git Global Config'),
            description: vscode.l10n.t(
                'These settings are backed by your global git config. The values will be overridden by repository config values.'
            ),
            fields: gitConfigFields('global')
        },
        {
            id: 'local',
            scope: 'local',
            title: vscode.l10n.t('Git Repository Config'),
            description: vscode.l10n.t(
                'These settings are backed by your local repository config. The values will override global config values.'
            ),
            fields: gitConfigFields('local')
        }
    ];
}

/** Static texts of the page. */
function strings(): Record<string, string> {
    return {
        refresh: vscode.l10n.t('Refresh'),
        unset: vscode.l10n.t('Unset'),
        inherited: vscode.l10n.t('Global: {0}'),
        browse: vscode.l10n.t('Browse...'),
        openFile: vscode.l10n.t('Open file'),
        openVsCodeSettings: vscode.l10n.t('All VS Code Git settings'),
        repository: vscode.l10n.t('Repository'),
        noRepository: vscode.l10n.t('No Git repository is open in this workspace.'),
        openRepositoryFolder: vscode.l10n.t('Open repository folder'),
        editGitignore: vscode.l10n.t('Edit .gitignore'),
        editGitattributes: vscode.l10n.t('Edit .gitattributes'),
        remotes: vscode.l10n.t('Remotes'),
        name: vscode.l10n.t('Name'),
        fetch: vscode.l10n.t('Fetch'),
        push: vscode.l10n.t('Push'),
        add: vscode.l10n.t('Add'),
        edit: vscode.l10n.t('Edit'),
        remove: vscode.l10n.t('Remove'),
        noRemotes: vscode.l10n.t('This repository has no remotes.')
    };
}
