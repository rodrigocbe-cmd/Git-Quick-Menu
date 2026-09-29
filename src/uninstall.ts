/*
 * `vscode:uninstall` hook: runs in plain Node after the extension is removed,
 * and undoes the main menu bar patch in every installation it was applied to.
 */
import * as fs from 'fs';
import * as path from 'path';
import { removePatch } from './menubarPatch';

const stateFile = path.join(__dirname, '..', '.menubar-patch.json');

try {
    const appRoots: string[] = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const appRoot of appRoots) {
        try {
            removePatch(appRoot);
        } catch {
            // Installation removed or not writable; nothing else to do.
        }
    }
} catch {
    // No state file: the patch was never applied.
}
