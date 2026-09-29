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
    { label: 'New Branch...', icon: 'git-branch-create', command: 'gitQuickMenu.newBranch', requiresRepository: true },
    { label: 'Checkout...', icon: 'git-branch', command: 'gitQuickMenu.checkout', requiresRepository: true },
    undefined,
    { label: 'Commit', icon: 'check', command: 'gitQuickMenu.commit', requiresRepository: true },
    { label: 'Commit & Push', icon: 'check-all', command: 'gitQuickMenu.commitAndPush', requiresRepository: true },
    undefined,
    { label: 'Pull', icon: 'arrow-down', command: 'gitQuickMenu.pull', requiresRepository: true },
    { label: 'Push', icon: 'arrow-up', command: 'gitQuickMenu.push', requiresRepository: true },
    { label: 'Fetch', icon: 'cloud-download', command: 'gitQuickMenu.fetch', requiresRepository: true },
    { label: 'Sync', icon: 'sync', command: 'gitQuickMenu.sync', requiresRepository: true },
    undefined,
    { label: 'Manage Branches...', icon: 'list-tree', command: 'gitQuickMenu.manageBranches', requiresRepository: true },
    { label: 'Manage Remotes...', icon: 'remote', command: 'gitQuickMenu.manageRemotes', requiresRepository: true },
    { label: 'Stash...', icon: 'archive', command: 'gitQuickMenu.stash', requiresRepository: true },
    { label: 'Git Log', icon: 'history', command: 'gitQuickMenu.log', requiresRepository: true },
    undefined,
    { label: 'Git Settings...', icon: 'settings-gear', command: 'gitQuickMenu.settings', requiresRepository: false }
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
            items.push({ label: `$(${entry.icon}) ${entry.label}`, command: entry.command });
        }
    }
    if (!hasRepository && git.isAvailable) {
        items.unshift(
            { label: '$(repo) Initialize Repository', command: 'git.init' },
            { label: '$(repo-clone) Clone Repository...', command: 'git.clone' },
            { label: '', kind: vscode.QuickPickItemKind.Separator }
        );
    }

    const pick = await vscode.window.showQuickPick<Item>(items, {
        title: menuTitle(git),
        placeHolder: 'Select a Git operation'
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
