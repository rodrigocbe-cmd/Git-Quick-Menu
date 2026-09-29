import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ACTIVE_CONTEXT_KEY, applyPatch, getPatchStatus, MenuIcons, removePatch } from './menubarPatch';
import { errorMessage } from './gitService';

const SETTING = 'mainMenuBar';

/** File in the extension folder listing patched installations, read by the uninstall hook. */
export const PATCH_STATE_FILE = '.menubar-patch.json';

/**
 * Keeps the "Git" entry of the main menu bar in sync with the
 * `gitQuickMenu.mainMenuBar` setting. VS Code updates replace the patched
 * file, so the patch is re-applied on startup while the setting is on.
 */
export function registerMainMenuBar(context: vscode.ExtensionContext): void {
    // Hides the placeholder item the patch adds to the Git submenu.
    vscode.commands.executeCommand('setContext', ACTIVE_CONTEXT_KEY, true);
    context.subscriptions.push(
        vscode.commands.registerCommand('gitQuickMenu.enableMainMenuBar', () => enable()),
        vscode.commands.registerCommand('gitQuickMenu.disableMainMenuBar', () =>
            config().update(SETTING, false, vscode.ConfigurationTarget.Global)
        ),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(`gitQuickMenu.${SETTING}`)) {
                sync(context, false);
            }
        })
    );
    sync(context, true);
    offerOnFirstRun(context);
}

/** Asks once whether to add the menu, since it is off by default. */
async function offerOnFirstRun(context: vscode.ExtensionContext): Promise<void> {
    const key = 'mainMenuBarOffered';
    if (context.globalState.get<boolean>(key) || config().get<boolean>(SETTING, false)) {
        return;
    }
    await context.globalState.update(key, true);
    const addLabel = vscode.l10n.t('Add Git Menu');
    const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t('Git Quick Menu: add a "Git" menu to the main menu bar, between "Terminal" and "Help"?'),
        addLabel,
        vscode.l10n.t('Not Now')
    );
    if (choice === addLabel) {
        await enable();
    }
}

async function enable(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Add "Git" to the main menu bar?'),
        {
            modal: true,
            detail:
                vscode.l10n.t(
                    'VS Code has no official API for top-level menus, so Git Quick Menu will modify a file of your ' +
                        'VS Code installation to add the "Git" menu between "Terminal" and "Help".'
                ) +
                '\n\n' +
                vscode.l10n.t(
                    'VS Code updates undo the change; the extension re-applies it automatically on the next start. ' +
                        'You can revert it at any time with "Git Menu: Remove Git from Main Menu Bar".'
                )
        },
        vscode.l10n.t('Add Git Menu')
    );
    if (choice) {
        await config().update(SETTING, true, vscode.ConfigurationTarget.Global);
    }
}

/** Codicons of the commands in the Git submenu, taken from their `icon` in package.json. */
function menuIcons(context: vscode.ExtensionContext): MenuIcons {
    const icons: MenuIcons = {};
    for (const command of context.extension.packageJSON.contributes.commands as { command: string; icon?: string }[]) {
        const codicon = /^\$\(([\w-]+)\)$/.exec(command.icon ?? '')?.[1];
        if (codicon) {
            icons[command.command] = codicon;
        }
    }
    return icons;
}

function sync(context: vscode.ExtensionContext, onStartup: boolean): void {
    const appRoot = vscode.env.appRoot;
    const wanted = config().get<boolean>(SETTING, false);
    const icons = menuIcons(context);
    const status = getPatchStatus(appRoot, icons);

    try {
        if (wanted && (status === 'unpatched' || status === 'outdated')) {
            applyPatch(appRoot, icons);
            writeState(context, appRoot, true);
            promptReload(
                status === 'outdated'
                    ? vscode.l10n.t('The Git menu in the main menu bar was updated. Reload the window to see it.')
                    : onStartup
                      ? vscode.l10n.t('The Git menu was re-added to the main menu bar after a VS Code update. Reload to see it.')
                      : vscode.l10n.t('The Git menu was added to the main menu bar. Reload the window to see it.')
            );
        } else if (wanted && status === 'unsupported') {
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    'Git Quick Menu cannot add the Git menu to the main menu bar in this VS Code version. ' +
                        'Use the status bar item or Ctrl+Alt+G instead.'
                )
            );
        } else if (!wanted && (status === 'patched' || status === 'outdated')) {
            removePatch(appRoot);
            writeState(context, appRoot, false);
            promptReload(vscode.l10n.t('The Git menu was removed from the main menu bar. Reload the window to apply.'));
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message =
            code === 'EPERM' || code === 'EACCES'
                ? vscode.l10n.t(
                      'No permission to modify the VS Code installation at "{0}". Run VS Code as administrator once and try again.',
                      appRoot
                  )
                : errorMessage(error);
        vscode.window.showErrorMessage(`Git Quick Menu: ${message}`);
    }
}

async function promptReload(message: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(message, vscode.l10n.t('Reload Window'));
    if (choice) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

function writeState(context: vscode.ExtensionContext, appRoot: string, patched: boolean): void {
    const file = path.join(context.extensionPath, PATCH_STATE_FILE);
    try {
        const roots = new Set<string>(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
        if (patched) {
            roots.add(appRoot);
        } else {
            roots.delete(appRoot);
        }
        fs.writeFileSync(file, JSON.stringify([...roots]), 'utf8');
    } catch {
        // Only used to undo the patch on uninstall; not critical.
    }
}

function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('gitQuickMenu');
}
