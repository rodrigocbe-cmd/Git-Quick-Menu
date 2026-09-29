import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from './gitService';

interface MenuEntry {
    label: string;
    icon: string;
    command: string;
    requiresRepository: boolean;
}

/** Same layout as the "Git" submenu contributed in package.json; `undefined` is a separator. */
const MENU: (MenuEntry | undefined)[] = [
    { label: 'Clone Repository...', icon: 'repo-clone', command: 'gitQuickMenu.clone', requiresRepository: false },
    { label: 'Local Repositories...', icon: 'blank', command: 'gitQuickMenu.localRepositories', requiresRepository: false },
    undefined,
    { label: 'Commit or Stash...', icon: 'blank', command: 'gitQuickMenu.commitOrStash', requiresRepository: true },
    undefined,
    { label: 'Fetch', icon: 'repo-fetch', command: 'gitQuickMenu.fetch', requiresRepository: true },
    { label: 'Pull', icon: 'arrow-down', command: 'gitQuickMenu.pull', requiresRepository: true },
    { label: 'Push', icon: 'arrow-up', command: 'gitQuickMenu.push', requiresRepository: true },
    { label: 'Sync (Pull then Push)', icon: 'sync', command: 'gitQuickMenu.sync', requiresRepository: true },
    undefined,
    { label: 'New Branch...', icon: 'git-branch-create', command: 'gitQuickMenu.newBranch', requiresRepository: true },
    { label: 'View Branch History', icon: 'history', command: 'gitQuickMenu.log', requiresRepository: true },
    { label: 'Manage Branches', icon: 'git-branch', command: 'gitQuickMenu.manageBranches', requiresRepository: true },
    undefined,
    { label: 'GitHub...', icon: 'blank', command: 'gitQuickMenu.github', requiresRepository: true },
    undefined,
    { label: 'Open in File Explorer', icon: 'folder-opened', command: 'gitQuickMenu.openInFileExplorer', requiresRepository: true },
    { label: 'Open in Command Prompt', icon: 'terminal-cmd', command: 'gitQuickMenu.openInCommandPrompt', requiresRepository: true },
    undefined,
    { label: 'Manage Remotes...', icon: 'settings-gear', command: 'gitQuickMenu.manageRemotes', requiresRepository: true },
    { label: 'Settings', icon: 'settings-gear', command: 'gitQuickMenu.settings', requiresRepository: false }
];

/** Opens the Git menu as a Quick Pick (used by the status bar item and the keybinding). */
export async function showMenu(git: GitService): Promise<void> {
    const hasRepository = git.repositories.length > 0;
    type Item = vscode.QuickPickItem & { command?: string };
    const items: Item[] = [];

    for (const entry of MENU) {
        if (!entry) {
            if (items.length && items[items.length - 1].kind !== vscode.QuickPickItemKind.Separator) {
                items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            }
        } else if (hasRepository || !entry.requiresRepository) {
            items.push({ label: `$(${entry.icon}) ${vscode.l10n.t(entry.label)}`, command: entry.command });
        }
    }
    if (!hasRepository && git.isAvailable) {
        items.unshift(
            { label: `$(repo) ${vscode.l10n.t('Initialize Repository')}`, command: 'git.init' },
            { label: '', kind: vscode.QuickPickItemKind.Separator }
        );
    }

    const pick = await vscode.window.showQuickPick<Item>(items, {
        title: menuTitle(git),
        placeHolder: vscode.l10n.t('Select a Git operation')
    });
    if (pick?.command) {
        await vscode.commands.executeCommand(pick.command);
    }
}

function menuTitle(git: GitService): string {
    const repositories = git.repositories;
    if (repositories.length !== 1) {
        return 'Git';
    }
    const repository = repositories[0];
    const branch = repository.state.HEAD?.name ?? repository.state.HEAD?.commit?.slice(0, 7);
    const name = path.basename(repository.rootUri.fsPath);
    return branch ? `Git — ${name} (${branch})` : `Git — ${name}`;
}
