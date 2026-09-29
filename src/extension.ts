import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { GitService } from './gitService';
import { showMenu } from './menu';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const git = new GitService();

    const statusBarItem = vscode.window.createStatusBarItem(
        'gitQuickMenu.statusBar',
        vscode.StatusBarAlignment.Left,
        50
    );
    statusBarItem.name = 'Git Quick Menu';
    statusBarItem.text = '$(source-control) Git';
    statusBarItem.tooltip = 'Open the Git menu (Ctrl+Alt+G)';
    statusBarItem.command = 'gitQuickMenu.showMenu';

    const refresh = () => {
        const hasRepository = git.repositories.length > 0;
        vscode.commands.executeCommand('setContext', 'gitQuickMenu.hasRepository', hasRepository);
        const showStatusBar = vscode.workspace
            .getConfiguration('gitQuickMenu')
            .get<boolean>('showStatusBarItem', true);
        if (showStatusBar && git.isAvailable) {
            statusBarItem.show();
        } else {
            statusBarItem.hide();
        }
    };

    registerCommands(context, git);
    context.subscriptions.push(
        git,
        statusBarItem,
        vscode.commands.registerCommand('gitQuickMenu.showMenu', () => showMenu(git)),
        git.onDidChangeRepositories(refresh),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gitQuickMenu')) {
                refresh();
            }
        })
    );

    refresh();
    await git.initialize();
}

export function deactivate(): void {}
