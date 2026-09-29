import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/*
 * VS Code has no public API for adding top-level menus to the main menu bar.
 * This module patches the installed workbench bundle to register one more
 * top-level entry, "Git", pointing at the submenu contributed in package.json
 * (extension submenus are registered internally as MenuId.for("api:<id>")).
 *
 * The patch has two blocks wrapped in marker comments:
 * - a statement inserted right before the built-in "Help" entry, registering
 *   the "Git" menu;
 * - an expression inserted in the menu item renderer, which shows the icons
 *   of this extension's commands in the left column of menus (where the
 *   check mark goes), as in Visual Studio. VS Code menus never show icons.
 *
 * The workbench checksum in product.json is updated so VS Code does not
 * report the installation as corrupt.
 *
 * This file must not import 'vscode': it is also used by the uninstall hook.
 */

export const SUBMENU_ID = 'gitQuickMenu.menu';

/** Context key set by the extension on activation; hides the placeholder item. */
export const ACTIVE_CONTEXT_KEY = 'gitQuickMenu.active';

/** Command id -> codicon name, shown next to the command in menus. */
export type MenuIcons = Record<string, string>;

export type PatchStatus = 'patched' | 'outdated' | 'unpatched' | 'unsupported';

const WORKBENCH_RELATIVE = 'out/vs/workbench/workbench.desktop.main.js';
const MARKER_START = '/*gitQuickMenu:start*/';
const MARKER_END = '/*gitQuickMenu:end*/';
const HELP_ENTRY = /(\w+)\.appendMenuItem\((\w+)\.MenubarMainMenu,\{submenu:\2\.MenubarHelpMenu,/;
/** Minified name of ContextKeyExpr, found through its `deserialize(x.when)` calls. */
const CONTEXT_KEY_EXPR = /\b(\w+)\.deserialize\(\w+\.when\)/;
/** Creation of the check mark column in the menu item renderer (base/browser/ui/menu). */
const MENU_ITEM_CHECK = /this\.check=\w+\(this\.item,\w+\("span\.menu-item-check"\+\w+\.asCSSSelector\(\w+\.menuSelection\)\)\),/;
const PATCH_BLOCK = new RegExp(`${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}`, 'g');

export function workbenchPath(appRoot: string): string {
    return path.join(appRoot, ...WORKBENCH_RELATIVE.split('/'));
}

export function getPatchStatus(appRoot: string, icons: MenuIcons): PatchStatus {
    const file = workbenchPath(appRoot);
    if (!fs.existsSync(file)) {
        return 'unsupported';
    }
    const source = fs.readFileSync(file, 'utf8');
    const original = source.replace(PATCH_BLOCK, '');
    const expected = buildPatched(original, icons);
    if (!expected) {
        return 'unsupported';
    }
    if (source === expected) {
        return 'patched';
    }
    return source.includes(MARKER_START) ? 'outdated' : 'unpatched';
}

/** Inserts the "Git" top-level menu. Throws if the bundle layout is not recognized. */
export function applyPatch(appRoot: string, icons: MenuIcons): void {
    const file = workbenchPath(appRoot);
    const source = fs.readFileSync(file, 'utf8').replace(PATCH_BLOCK, '');
    const patched = buildPatched(source, icons);
    if (!patched) {
        throw new Error('This VS Code version is not supported: the main menu bar registration was not found.');
    }

    const backup = `${file}.gitQuickMenu.bak`;
    if (!fs.existsSync(backup)) {
        writeAtomic(backup, source);
    }
    writeAtomic(file, patched);
    updateChecksum(appRoot, patched);
}

/** Removes the "Git" top-level menu, restoring the original bundle and checksum. */
export function removePatch(appRoot: string): void {
    const file = workbenchPath(appRoot);
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes(MARKER_START)) {
        return;
    }
    const restored = source.replace(PATCH_BLOCK, '');
    writeAtomic(file, restored);
    updateChecksum(appRoot, restored);
    fs.rmSync(`${file}.gitQuickMenu.bak`, { force: true });
}

/** Returns the unpatched `source` with both patch blocks, or undefined if its layout is not recognized. */
function buildPatched(source: string, icons: MenuIcons): string | undefined {
    const help = HELP_ENTRY.exec(source);
    const check = MENU_ITEM_CHECK.exec(source);
    const contextKeyExpr = CONTEXT_KEY_EXPR.exec(source)?.[1];
    if (!help || !check || !contextKeyExpr) {
        return undefined;
    }
    const [, registry, menuId] = help;
    const submenu = `${menuId}.for(${JSON.stringify(`api:${SUBMENU_ID}`)})`;
    const title = 'Git';
    // Order 7.5: between "Terminal" (7) and "Help" (8).
    const entry =
        `${registry}.appendMenuItem(${menuId}.MenubarMainMenu,{submenu:${submenu},` +
        `title:{value:${JSON.stringify(title)},original:${JSON.stringify(title)},mnemonicTitle:${JSON.stringify(`&&${title}`)}},order:7.5});`;
    // The menu bar skips submenus that are empty when it is built, and the
    // extension's items only arrive later. This placeholder keeps the submenu
    // non-empty at startup and is hidden once the extension activates.
    const placeholder =
        `${registry}.appendMenuItem(${submenu},{command:{id:"gitQuickMenu.showMenu",title:"Git Quick Menu..."},` +
        `group:"9_placeholder",when:${contextKeyExpr}.deserialize(${JSON.stringify(`!${ACTIVE_CONTEXT_KEY}`)})});`;
    const iconMap = `globalThis.gitQuickMenuIcons=${JSON.stringify(icons)};`;
    // Runs inside the renderer, right after the check mark column is created:
    // turns that column into the command's icon, always visible.
    const iconRenderer =
        `(globalThis.gitQuickMenuIcons?.[this._action?.id]&&(` +
        `this.check.className="menu-item-check codicon codicon-"+globalThis.gitQuickMenuIcons[this._action.id],` +
        `Object.assign(this.check.style,{visibility:"visible",display:"flex",alignItems:"center",justifyContent:"center"}))),`;

    // Insert the later block first so the earlier index stays valid.
    const inserts = [
        { index: help.index, text: MARKER_START + entry + placeholder + iconMap + MARKER_END },
        { index: check.index + check[0].length, text: MARKER_START + iconRenderer + MARKER_END }
    ].sort((a, b) => b.index - a.index);
    let patched = source;
    for (const { index, text } of inserts) {
        patched = patched.slice(0, index) + text + patched.slice(index);
    }
    return patched;
}

function updateChecksum(appRoot: string, content: string): void {
    const productFile = path.join(appRoot, 'product.json');
    if (!fs.existsSync(productFile)) {
        return;
    }
    const product = fs.readFileSync(productFile, 'utf8');
    const checksum = crypto.createHash('sha256').update(content, 'utf8').digest('base64').replace(/=+$/, '');
    // product.json keys are relative to the "out" folder.
    const key = WORKBENCH_RELATIVE.replace(/^out\//, '');
    const entry = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*")[^"]*(")`);
    if (entry.test(product)) {
        writeAtomic(productFile, product.replace(entry, `$1${checksum}$2`));
    }
}

/** Writes through a temporary file so other windows never read a half-written bundle. */
function writeAtomic(file: string, content: string): void {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, file);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
