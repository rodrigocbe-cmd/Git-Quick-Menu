import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { gitPath } from './gitService';

/*
 * The extension runs on the Node.js bundled with VS Code, so its only
 * external requirement is Git. When git is missing, offer to install it:
 * with winget on Windows, with the Xcode Command Line Tools on macOS, and
 * through the download page elsewhere.
 */

const DOWNLOAD_URL = 'https://git-scm.com/downloads';
const SKIP_KEY = 'skipGitInstallPrompt';

export async function checkRequirements(context: vscode.ExtensionContext): Promise<void> {
    if (context.globalState.get<boolean>(SKIP_KEY) || (await succeeds(gitPath(), ['--version']))) {
        return;
    }
    const installer = await findInstaller();
    const installLabel = vscode.l10n.t('Install Git');
    const downloadLabel = vscode.l10n.t('Open Download Page');
    const skipLabel = vscode.l10n.t("Don't Ask Again");
    const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Git Quick Menu needs Git, which was not found on this computer.'),
        {
            modal: true,
            detail: installer
                ? vscode.l10n.t('Git can be installed now by running this command in a terminal:\n\n{0}', installer.display)
                : vscode.l10n.t('Download and install Git, then restart VS Code.')
        },
        ...(installer ? [installLabel] : []),
        downloadLabel,
        skipLabel
    );
    if (choice === installLabel && installer) {
        install(installer);
    } else if (choice === downloadLabel) {
        await vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
    } else if (choice === skipLabel) {
        await context.globalState.update(SKIP_KEY, true);
    }
}

interface Installer {
    /** Command shown to the user before running it. */
    display: string;
    shellPath: string;
    shellArgs: string[];
    /** Shown when the command exits successfully. */
    doneMessage: string;
}

async function findInstaller(): Promise<Installer | undefined> {
    if (process.platform === 'win32' && (await succeeds('winget', ['--version']))) {
        const command =
            'winget install --id Git.Git --exact --source winget ' +
            '--accept-package-agreements --accept-source-agreements';
        // Keeps the terminal open on failure so the user can read the output.
        const prompt = vscode.l10n.t('Press Enter to close').replace(/'/g, "''");
        const script = `${command}; if ($LASTEXITCODE -ne 0) { Read-Host '${prompt}' }; exit $LASTEXITCODE`;
        return {
            display: command,
            shellPath: 'powershell.exe',
            shellArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
            // VS Code only sees the new PATH after a full restart.
            doneMessage: vscode.l10n.t('Git was installed. Close and reopen VS Code to start using it.')
        };
    }
    if (process.platform === 'darwin') {
        // Opens the system dialog that installs the Command Line Tools, which include git.
        return {
            display: 'xcode-select --install',
            shellPath: '/bin/sh',
            shellArgs: ['-c', 'xcode-select --install'],
            doneMessage: vscode.l10n.t('Finish the installation in the window macOS opened, then restart VS Code.')
        };
    }
    return undefined;
}

/** Runs the installer in a visible terminal and reports the result when it closes. */
function install(installer: Installer): void {
    const terminal = vscode.window.createTerminal({
        name: vscode.l10n.t('Install Git'),
        shellPath: installer.shellPath,
        shellArgs: installer.shellArgs
    });
    terminal.show();
    const listener = vscode.window.onDidCloseTerminal(async closed => {
        if (closed !== terminal) {
            return;
        }
        listener.dispose();
        if (closed.exitStatus?.code === 0) {
            vscode.window.showInformationMessage(installer.doneMessage);
        } else {
            const downloadLabel = vscode.l10n.t('Open Download Page');
            const choice = await vscode.window.showErrorMessage(
                vscode.l10n.t('Git could not be installed automatically.'),
                downloadLabel
            );
            if (choice) {
                await vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
            }
        }
    });
}

function succeeds(command: string, args: string[]): Promise<boolean> {
    return new Promise(resolve =>
        execFile(command, args, { windowsHide: true, timeout: 15000 }, error => resolve(!error))
    );
}
