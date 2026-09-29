/*
 * Subset of the public API exposed by the built-in `vscode.git` extension.
 * Full definition: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 * Only the members used by this extension are declared here.
 */

import { Event, Uri } from 'vscode';

export interface GitExtension {
    readonly enabled: boolean;
    readonly onDidChangeEnablement: Event<boolean>;
    getAPI(version: 1): API;
}

export type APIState = 'uninitialized' | 'initialized';

export interface API {
    readonly state: APIState;
    readonly onDidChangeState: Event<APIState>;
    readonly repositories: Repository[];
    readonly onDidOpenRepository: Event<Repository>;
    readonly onDidCloseRepository: Event<Repository>;
    getRepository(uri: Uri): Repository | null;
}

export const enum RefType {
    Head,
    RemoteHead,
    Tag
}

export interface Ref {
    readonly type: RefType;
    readonly name?: string;
    readonly commit?: string;
    readonly remote?: string;
}

export interface UpstreamRef {
    readonly remote: string;
    readonly name: string;
}

export interface Branch extends Ref {
    readonly upstream?: UpstreamRef;
    readonly ahead?: number;
    readonly behind?: number;
}

export interface Remote {
    readonly name: string;
    readonly fetchUrl?: string;
    readonly pushUrl?: string;
    readonly isReadOnly: boolean;
}

export interface Change {
    readonly uri: Uri;
}

export interface RepositoryState {
    readonly HEAD: Branch | undefined;
    readonly remotes: Remote[];
    readonly mergeChanges: Change[];
    readonly indexChanges: Change[];
    readonly workingTreeChanges: Change[];
    readonly onDidChange: Event<void>;
}

export interface InputBox {
    value: string;
}

export interface Commit {
    readonly hash: string;
    readonly message: string;
    readonly parents: string[];
    readonly authorDate?: Date;
    readonly authorName?: string;
    readonly authorEmail?: string;
}

export interface LogOptions {
    readonly maxEntries?: number;
}

export interface CommitOptions {
    all?: boolean | 'tracked';
}

export interface FetchOptions {
    remote?: string;
    ref?: string;
    all?: boolean;
    prune?: boolean;
    depth?: number;
}

export interface BranchQuery {
    readonly remote?: boolean;
    readonly pattern?: string;
    readonly count?: number;
    readonly contains?: string;
    readonly sort?: 'alphabetically' | 'committerdate';
}

export interface Repository {
    readonly rootUri: Uri;
    readonly inputBox: InputBox;
    readonly state: RepositoryState;

    status(): Promise<void>;
    checkout(treeish: string): Promise<void>;
    createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
    deleteBranch(name: string, force?: boolean): Promise<void>;
    getBranches(query: BranchQuery): Promise<Ref[]>;
    addRemote(name: string, url: string): Promise<void>;
    removeRemote(name: string): Promise<void>;
    fetch(options?: FetchOptions): Promise<void>;
    pull(unshallow?: boolean): Promise<void>;
    push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
    commit(message: string, opts?: CommitOptions): Promise<void>;
    log(options?: LogOptions): Promise<Commit[]>;
}
