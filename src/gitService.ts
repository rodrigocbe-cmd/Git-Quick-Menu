import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { API, GitExtension, Repository } from './typings/git';

/**
 * Wraps the built-in Git extension API: tracks open repositories and
 * picks the repository a command should act on.
 */
export class GitService implements vscode.Disposable {
    private api: API | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private apiDisposables: vscode.Disposable[] = [];
    private readonly onDidChangeRepositoriesEmitter = new vscode.EventEmitter<void>();

    readonly onDidChangeRepositories = this.onDidChangeRepositoriesEmitter.event;

    async initialize(): Promise<void> {
        const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!extension) {
            return;
        }
        const gitExtension = await extension.activate();
        this.disposables.push(
            gitExtension.onDidChangeEnablement(enabled =>
                this.setApi(enabled ? gitExtension.getAPI(1) : undefined)
            )
        );
        this.setApi(gitExtension.enabled ? gitExtension.getAPI(1) : undefined);
    }

    get isAvailable(): boolean {
        return this.api !== undefined;
    }

    get repositories(): Repository[] {
        return this.api?.repositories ?? [];
    }

    /**
     * Returns the repository to act on: the only one, the one containing the
     * active editor, or the one the user picks.
     */
    async pickRepository(): Promise<Repository | undefined> {
        if (!this.api) {
            vscode.window.showErrorMessage('The built-in Git extension is disabled or unavailable.');
            return undefined;
        }
        const repositories = this.api.repositories;
        if (repositories.length === 0) {
            vscode.window.showInformationMessage('No Git repository found in the current workspace.');
            return undefined;
        }
        if (repositories.length === 1) {
            return repositories[0];
        }
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const activeRepository = activeUri && this.api.getRepository(activeUri);
        if (activeRepository) {
            return activeRepository;
        }
        const pick = await vscode.window.showQuickPick(
            repositories.map(repository => ({
                label: path.basename(repository.rootUri.fsPath),
                description: repository.rootUri.fsPath,
                repository
            })),
            { placeHolder: 'Select a repository' }
        );
        return pick?.repository;
    }

    dispose(): void {
        this.apiDisposables.forEach(d => d.dispose());
        this.disposables.forEach(d => d.dispose());
        this.onDidChangeRepositoriesEmitter.dispose();
    }

    private setApi(api: API | undefined): void {
        this.apiDisposables.forEach(d => d.dispose());
        this.apiDisposables = [];
        this.api = api;
        if (api) {
            const fire = () => this.onDidChangeRepositoriesEmitter.fire();
            this.apiDisposables.push(
                api.onDidOpenRepository(fire),
                api.onDidCloseRepository(fire),
                api.onDidChangeState(fire)
            );
        }
        this.onDidChangeRepositoriesEmitter.fire();
    }
}

/**
 * Runs a git command in the repository root for operations the Git extension
 * API does not expose (rename, merge, stash, show...). Resolves with stdout.
 */
export function runGit(repository: Repository, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            gitPath(),
            args,
            { cwd: repository.rootUri.fsPath, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr.trim() || error.message));
                } else {
                    resolve(stdout);
                }
            }
        );
    });
}

function gitPath(): string {
    const configured = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
    if (typeof configured === 'string' && configured) {
        return configured;
    }
    if (Array.isArray(configured) && configured.length > 0) {
        return configured[0];
    }
    return 'git';
}

/** Extracts the most useful message from errors thrown by the Git API or runGit. */
export function errorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
        const { stderr, message } = error as { stderr?: string; message?: string };
        if (stderr?.trim()) {
            return stderr.trim();
        }
        if (message) {
            return message;
        }
    }
    return String(error);
}
