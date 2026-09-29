# Git Quick Menu

Adds a Visual Studio-style **Git** menu to VS Code, with the common Git
operations grouped in one place.

> This is not an official Microsoft extension.

## Where the menu shows up

VS Code does not let extensions add top-level menus to the main menu bar
(File, Edit, ...), so the **Git** menu shows up in these places:

| Place | How to open it |
|---|---|
| Status Bar | Click **Git** in the bottom-left corner |
| Shortcut | `Ctrl+Alt+G` (`Cmd+Alt+G` on macOS) |
| Editor title bar | Source Control icon, top right of the editor |
| Source Control view | Source Control icon in the view title |
| Command Palette | Type `Git Menu:` |

## Operations

```text
Git
├── New Branch...
├── Checkout...
├── ───────────────
├── Commit
├── Commit & Push
├── ───────────────
├── Pull
├── Push
├── Fetch
├── Sync
├── ───────────────
├── Manage Branches...   (checkout, merge, rename, delete)
├── Manage Remotes...    (add, fetch, change URL, rename, remove)
├── Stash...             (stash, pop, apply, view, drop)
├── Git Log              (commit list, opens the diff)
├── ───────────────
└── Git Settings...
```

Items are enabled only when the workspace has a Git repository open. With no
repository, the Quick Pick offers **Initialize Repository** and **Clone
Repository**.

## Settings

| Setting | Default | Description |
|---|---|---|
| `gitQuickMenu.showStatusBarItem` | `true` | Shows the **Git** item in the Status Bar |
| `gitQuickMenu.showInEditorTitle` | `true` | Shows the submenu in the editor title bar |
| `gitQuickMenu.showInSourceControl` | `true` | Shows the submenu in the Source Control view |
| `gitQuickMenu.logMaxEntries` | `100` | Number of commits shown by **Git Log** |

## Development

Requirements: [Node.js](https://nodejs.org/) 20+ and VS Code 1.90+.

```bash
npm install
npm run compile
```

- **Test:** open the folder in VS Code and press `F5`. A new window (Extension
  Development Host) opens with the extension loaded.
- **Package:** `npm run package` creates `git-quick-menu-<version>.vsix`.
- **Install the .vsix:** `code --install-extension git-quick-menu-0.1.0.vsix`

## How it works

The extension uses the public API of the built-in `vscode.git` extension for
branches, commit, push/pull/fetch and remotes. That reuses its authentication
and keeps the Source Control view in sync. For operations the API does not
expose (merge, rename, stash, `git show`), it runs the `git` executable
directly, respecting the `git.path` setting.

```text
src/
├── extension.ts      # activation, status bar, context key
├── menu.ts           # Git menu as a Quick Pick
├── commands.ts       # implementation of the commands
├── gitService.ts     # Git API access, repository picker, runGit
└── typings/git.d.ts  # subset of the vscode.git API types
```
