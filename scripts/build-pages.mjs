#!/usr/bin/env node
/**
 * Static packaging for GitHub Pages (or any static host, at any sub-path).
 *
 *   node scripts/build-pages.mjs --index          copy demo.html to index.html (what `npm run build` does)
 *   node scripts/build-pages.mjs --site [dir]     assemble the deployable site in `dir` (default _site)
 *
 * `--site` expects `npm run build` to have run first (it needs dist/). It copies exactly what the
 * game needs and then VERIFIES the result, failing the build instead of shipping a broken site:
 *
 *   - every `href` / `src` in the pages is relative and points at a file in the site;
 *   - every import in the compiled JavaScript is relative (browsers have no module resolution
 *     for bare names like "three") and points at a file in the site;
 *   - every one of those paths matches the file's real capitalisation. Windows and macOS find
 *     `inputmanager.js` when the file is `InputManager.js`; Linux (GitHub Actions, and Pages)
 *     does not, and that is the classic "works on my machine, 404 once deployed" bug.
 *
 * No dependencies: plain Node.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Pages shipped as they are. `index.html` is made from `demo.html`. */
export const PAGE_FILES = ['demo.html', 'input-demo.html', 'styles.css'];
export const ENTRY_PAGE = 'demo.html';
export const DEFAULT_SITE_DIR = '_site';

export function projectRoot() {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** Copies demo.html over index.html in the project root, so `/` loads the game. Returns the path. */
export function copyIndex(root = projectRoot()) {
    const from = join(root, ENTRY_PAGE);
    const to = join(root, 'index.html');
    if (!existsSync(from)) throw new Error(`Cannot make index.html: ${ENTRY_PAGE} is missing.`);
    copyFileSync(from, to);
    return to;
}

/** True only if every segment of `relPath` exists with exactly this capitalisation. */
export function existsExact(baseDir, relPath) {
    let dir = baseDir;
    const parts = relPath.split(/[\\/]+/).filter(part => part !== '' && part !== '.');
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part === '..') return false;
        let names;
        try {
            names = readdirSync(dir);
        } catch {
            return false;
        }
        if (!names.includes(part)) return false;
        dir = join(dir, part);
        if (i < parts.length - 1 && !statSync(dir).isDirectory()) return false;
    }
    return true;
}

/**
 * True if `relPath` would resolve on a case-INsensitive disk (Windows, macOS) but not on a case-sensitive
 * one (Linux, GitHub Pages). Decided by comparing directory listings, never by asking the OS, so the answer
 * is the same wherever this runs.
 */
export function hasCaseMismatch(baseDir, relPath) {
    let dir = baseDir;
    for (const part of relPath.split(/[\\/]+/).filter(p => p !== '' && p !== '.')) {
        let names;
        try {
            names = readdirSync(dir);
        } catch {
            return false;
        }
        if (names.includes(part)) {
            dir = join(dir, part);
            continue;
        }
        // A different spelling of this segment exists, so only the capitalisation is wrong.
        return names.some(name => name.toLowerCase() === part.toLowerCase());
    }
    return false;
}

function walk(dir, filter) {
    const found = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) found.push(...walk(full, filter));
        else if (filter(full)) found.push(full);
    }
    return found;
}

const toPosix = path => path.split(sep).join('/');

/** `href` / `src` values in an HTML document. */
export function htmlReferences(html) {
    const refs = [];
    const pattern = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    for (const match of html.matchAll(pattern)) refs.push(match[1] ?? match[2] ?? '');
    return refs;
}

/** Module specifiers in compiled JavaScript: `import x from '...'`, `export * from '...'`, `import('...')`. */
export function jsSpecifiers(source) {
    const specs = [];
    const patterns = [
        /\b(?:import|export)\s[^'";]*?\sfrom\s*(?:"([^"]+)"|'([^']+)')/g,
        /\bimport\s*(?:"([^"]+)"|'([^']+)')/g,
        /\bimport\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g,
    ];
    for (const pattern of patterns) for (const match of source.matchAll(pattern)) specs.push(match[1] ?? match[2] ?? '');
    return specs;
}

/**
 * Checks a built site. Returns a list of human-readable problems (empty = fine).
 * `site` is the directory that will be served at the site's base URL.
 */
export function verifySite(site) {
    const problems = [];
    if (!existsExact(site, 'index.html')) problems.push('index.html is missing, so the root URL would not load the game.');

    const check = (fromFile, ref, kind) => {
        const clean = ref.split('#')[0].split('?')[0];
        if (clean === '') return;
        if (/^(mailto:|tel:|data:|javascript:)/i.test(clean)) return;
        if (/^(https?:)?\/\//i.test(clean)) return; // a deliberate external resource
        if (clean.startsWith('/')) {
            problems.push(`${fromFile}: ${kind} "${ref}" is root-absolute and breaks on a sub-path; use a relative URL such as "./...".`);
            return;
        }
        if (!clean.startsWith('.') && kind === 'import') {
            problems.push(`${fromFile}: import "${ref}" is a bare module name; browsers cannot resolve it without a bundler or an import map.`);
            return;
        }
        const base = dirname(join(site, fromFile));
        const target = resolve(base, clean);
        const rel = relative(site, target);
        if (rel.startsWith('..')) {
            problems.push(`${fromFile}: ${kind} "${ref}" points outside the site.`);
            return;
        }
        const wanted = clean.endsWith('/') ? posix.join(toPosix(rel), 'index.html') : toPosix(rel);
        if (!existsExact(site, wanted)) {
            const wrongCase = hasCaseMismatch(site, wanted);
            problems.push(`${fromFile}: ${kind} "${ref}" ${wrongCase ? 'has the wrong capitalisation (it works on Windows/macOS but 404s on Linux)' : 'does not exist in the site'}.`);
        }
    };

    for (const file of walk(site, f => f.endsWith('.html'))) {
        const name = toPosix(relative(site, file));
        for (const ref of htmlReferences(readFileSync(file, 'utf8'))) check(name, ref, 'URL');
    }
    for (const file of walk(site, f => f.endsWith('.js'))) {
        const name = toPosix(relative(site, file));
        for (const spec of jsSpecifiers(readFileSync(file, 'utf8'))) check(name, spec, 'import');
    }
    return problems;
}

/**
 * Assembles the deployable site in `out` from `root` (which must already contain dist/).
 * Throws if the result does not verify. Returns the list of files written, relative to `out`.
 */
export function buildSite(root = projectRoot(), out = join(root, DEFAULT_SITE_DIR)) {
    const dist = join(root, 'dist');
    if (!existsSync(join(dist, 'src', 'main.js'))) {
        throw new Error('dist/src/main.js is missing. Run `npm run build` first.');
    }
    for (const page of PAGE_FILES) {
        if (!existsSync(join(root, page))) throw new Error(`${page} is missing from the project.`);
    }
    if (resolve(out) === resolve(root) || resolve(root).startsWith(resolve(out) + sep)) {
        throw new Error('The output directory must not be the project itself or one of its parents.');
    }

    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const page of PAGE_FILES) copyFileSync(join(root, page), join(out, page));
    copyFileSync(join(root, ENTRY_PAGE), join(out, 'index.html'));
    // Only the runnable JavaScript: no declarations, source maps (they point at .ts files that are not deployed) or tests.
    cpSync(dist, join(out, 'dist'), {
        recursive: true,
        filter: source => statSync(source).isDirectory() || source.endsWith('.js'),
    });
    // The site is served as-is: tell Jekyll (used by "deploy from a branch") to leave it alone.
    writeFileSync(join(out, '.nojekyll'), '');

    const problems = verifySite(out);
    if (problems.length > 0) {
        throw new Error(`The site has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n  - ${problems.join('\n  - ')}`);
    }
    return walk(out, () => true).map(file => toPosix(relative(out, file))).sort();
}

function main(argv) {
    const root = projectRoot();
    if (argv.includes('--index')) {
        copyIndex(root);
        return;
    }
    const at = argv.indexOf('--site');
    if (at === -1) {
        console.error('Usage: build-pages.mjs --index | --site [dir]');
        process.exitCode = 2;
        return;
    }
    const dirArg = argv[at + 1];
    const out = resolve(root, dirArg && !dirArg.startsWith('--') ? dirArg : DEFAULT_SITE_DIR);
    const files = buildSite(root, out);
    console.log(`Site ready in ${relative(process.cwd(), out) || '.'}: ${files.length} files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
