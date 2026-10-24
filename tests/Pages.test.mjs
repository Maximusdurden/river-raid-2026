import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, copyIndex, existsExact, hasCaseMismatch, htmlReferences, jsSpecifiers, verifySite } from '../scripts/build-pages.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

/** A scratch site: a copy of the real one, so tests can break it in a controlled way. */
function scratch(t) {
    const out = mkdtempSync(join(tmpdir(), 'raid-site-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    buildSite(ROOT, out);
    return out;
}

// --------------------------------------------------------- the real pages

test('the game page loads everything with relative URLs', () => {
    const html = read('demo.html');
    const refs = htmlReferences(html);
    assert.ok(refs.includes('./styles.css'));
    assert.ok(refs.includes('./dist/src/main.js'));
    for (const ref of refs) {
        assert.ok(!ref.startsWith('/'), `root-absolute URL: ${ref}`);
        assert.ok(!/^https?:/i.test(ref) || false, `unexpected external URL: ${ref}`);
    }
    assert.equal(/<style[\s>]/i.test(html), false, 'styles live in styles.css, not inline');
    assert.match(html, /<script type="module" src="\.\/dist\/src\/main\.js">/);
});

test('every page the site ships is free of root-absolute and external URLs', () => {
    for (const page of ['demo.html', 'input-demo.html']) {
        for (const ref of htmlReferences(read(page))) {
            assert.ok(!ref.startsWith('/'), `${page}: ${ref}`);
            assert.ok(!/^(https?:)?\/\//i.test(ref), `${page}: ${ref}`);
        }
    }
    assert.equal(htmlReferences(read('input-demo.html')).includes('./'), true, 'the back link is "./", not "/"');
});

// Regression: a bad scripted edit once spliced fragments of markup *after* </html>, and the
// URL-only checks above could not see it. These look at the document's actual structure.
const VOID = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);

/** Returns a list of structural problems in a hand-written HTML page (empty = well formed). */
function structureProblems(html) {
    const problems = [];
    const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!doctype[^>]*>/i, '');
    const stack = [];
    const tag = /<(\/?)([a-z][a-z0-9-]*)\b[^>]*?(\/?)>/gi;
    let last = 0;
    for (let m = tag.exec(body); m; m = tag.exec(body)) {
        const [whole, closing, rawName, selfClose] = m;
        const name = rawName.toLowerCase();
        last = m.index + whole.length;
        if (VOID.has(name) || selfClose) continue;
        if (!closing) {
            stack.push(name);
            if (name === 'script' || name === 'style') {   // raw text: skip to the matching close
                const end = body.toLowerCase().indexOf(`</${name}>`, last);
                if (end < 0) { problems.push(`unterminated <${name}>`); break; }
                tag.lastIndex = end;
            }
        } else if (stack[stack.length - 1] === name) {
            stack.pop();
        } else {
            problems.push(`</${name}> closes <${stack[stack.length - 1] ?? 'nothing'}>`);
            const at = stack.lastIndexOf(name);
            if (at >= 0) stack.length = at; // recover, so one slip is reported once
        }
    }
    if (stack.length) problems.push(`unclosed: ${stack.join(' > ')}`);
    const after = body.slice(body.toLowerCase().lastIndexOf('</html>') + '</html>'.length).trim();
    if (after) problems.push(`content after </html>: ${JSON.stringify(after.slice(0, 40))}`);
    if ((html.match(/<\/html>/gi) ?? []).length !== 1) problems.push('expected exactly one </html>');
    return problems;
}

test('the checker itself catches content spliced after </html> and misnested tags', () => {
    assert.deepEqual(structureProblems('<!doctype html><html><body><p>x</p></body></html>\n'), []);
    assert.ok(structureProblems('<html><body></body></html>5 /<kbd>x</kbd>').some(p => /after <\/html>/.test(p)));
    assert.ok(structureProblems('<html><body><a>x</div></body></html>').length > 0);
    assert.ok(structureProblems('<html><body><button>x</body></html>').some(p => /unclosed|closes/.test(p)));
});

test('the game page is a well-formed document with nothing after </html>', () => {
    for (const page of ['demo.html', 'input-demo.html']) {
        assert.deepEqual(structureProblems(read(page)), [], page);
    }
});

test('every element main.ts looks up exists in the game page, in the right place', () => {
    const html = read('demo.html');
    const source = read('src', 'main.ts');
    const ids = [...source.matchAll(/\bbyId\(\s*'([^']+)'/g)].map(m => m[1]);
    assert.ok(ids.length >= 12, `expected to find main.ts lookups, found ${ids.length}`);
    for (const id of ids) {
        assert.equal((html.match(new RegExp(`\\sid="${id}"`, 'g')) ?? []).length, 1, `#${id} must appear exactly once`);
    }
    const stage = html.slice(html.indexOf('id="stage"'), html.indexOf('<footer'));
    assert.ok(stage.includes('id="options-button"'), 'the Options button lives inside #stage, before the footer');
    assert.ok(!/<a\b[^>]*>[^<]*<button/.test(html), 'no button nested inside a link');
    assert.match(html, /<h1>[^<]*<span>\/ Phase 6<\/span><\/h1>/);

    // Production defaults: neither developer toggle starts ticked, and a browser may not restore one on reload.
    for (const id of ['debug-toggle', 'guides-toggle']) {
        const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
        assert.ok(tag, `#${id} exists`);
        assert.ok(!/\schecked(\s|=|>|\/)/.test(tag), `#${id} must not start checked`);
        assert.match(tag, /autocomplete="off"/, `#${id} needs autocomplete=off so a reload cannot restore it`);
    }
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.ok(header.includes('id="scores-button"'), 'the High Scores button is in the header');
    assert.match(header, /High Scores/);
});

test('the stylesheet pulls in nothing external', () => {
    const css = read('styles.css');
    assert.equal(/url\(\s*['"]?\s*(https?:)?\/\//i.test(css), false);
    assert.equal(/@import/i.test(css), false);
    assert.equal(/url\(\s*['"]?\//.test(css), false, 'no root-absolute url()');
});

test('package.json builds the TypeScript, copies the index, and offers a pages target', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    assert.match(scripts.build, /tsc -p tsconfig\.json/);
    assert.match(scripts.build, /build-pages\.mjs --index/);
    assert.match(scripts['build:pages'], /build-pages\.mjs --site/);
    assert.ok(scripts.typecheck && scripts.test);
});

test('index.html and _site are generated, so they are git-ignored', () => {
    const ignore = read('.gitignore').split(/\r?\n/);
    assert.ok(ignore.includes('index.html'));
    assert.ok(ignore.includes('_site/'));
    assert.ok(ignore.includes('node_modules/') && ignore.includes('dist/'));
});

// ---------------------------------------------------------------- index copy

test('copyIndex makes index.html an exact copy of demo.html', t => {
    const dir = mkdtempSync(join(tmpdir(), 'raid-index-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'demo.html'), '<!doctype html><title>x</title>');
    const made = copyIndex(dir);
    assert.equal(made, join(dir, 'index.html'));
    assert.equal(readFileSync(made, 'utf8'), '<!doctype html><title>x</title>');
    writeFileSync(join(dir, 'demo.html'), 'new');
    copyIndex(dir);
    assert.equal(readFileSync(made, 'utf8'), 'new', 'refreshed on every build');
});

test('copyIndex explains itself when demo.html is missing', t => {
    const dir = mkdtempSync(join(tmpdir(), 'raid-index-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.throws(() => copyIndex(dir), /demo\.html is missing/);
});

test('after `npm run build` the root has an index.html identical to the game page', () => {
    assert.ok(existsSync(join(ROOT, 'index.html')), 'run `npm run build` first');
    assert.equal(read('index.html'), read('demo.html'));
});

// ---------------------------------------------------------- the built site

test('the built site is self-contained and starts at index.html', t => {
    const site = scratch(t);
    for (const file of ['index.html', 'demo.html', 'input-demo.html', 'styles.css', '.nojekyll', 'dist/src/main.js', 'dist/src/core/InputManager.js', 'dist/src/ui/OptionsModal.js']) {
        assert.ok(existsExact(site, file), file);
    }
    assert.equal(readFileSync(join(site, 'index.html'), 'utf8'), read('demo.html'));
    assert.deepEqual(verifySite(site), []);
});

test('the site ships only what it needs: no sources, tests, maps, declarations or the old prototype', t => {
    const site = scratch(t);
    for (const absent of ['src', 'tests', 'node_modules', 'package.json', 'legacy.html', 'game.js', 'tsconfig.json', 'README.md']) {
        assert.equal(existsSync(join(site, absent)), false, absent);
    }
    const stray = [];
    const walk = dir => {
        for (const entry of readdirSyncSafe(dir)) {
            const full = join(dir, entry);
            if (entry.endsWith('.map') || entry.endsWith('.d.ts') || entry.endsWith('.ts')) stray.push(full);
            if (!entry.includes('.')) walk(full);
            else if (statIsDir(full)) walk(full);
        }
    };
    walk(site);
    assert.deepEqual(stray, []);
});

import { readdirSync, statSync } from 'node:fs';
const readdirSyncSafe = dir => { try { return readdirSync(dir); } catch { return []; } };
const statIsDir = path => { try { return statSync(path).isDirectory(); } catch { return false; } };

test('every module the game imports is present in the site (no 404 at load time)', t => {
    const site = scratch(t);
    const seen = new Set();
    const queue = ['dist/src/main.js'];
    while (queue.length > 0) {
        const file = queue.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        assert.ok(existsExact(site, file), `${file} is missing`);
        const source = readFileSync(join(site, file), 'utf8');
        for (const spec of jsSpecifiers(source)) {
            assert.match(spec, /^\.{1,2}\//, `${file}: "${spec}" must be a relative import`);
            queue.push(join(dirname(file), spec).split('\\').join('/'));
        }
    }
    assert.ok(seen.size > 20, `only ${seen.size} modules reached from main.js`);
    assert.ok([...seen].some(f => f.endsWith('core/InputManager.js')));
    assert.ok([...seen].some(f => f.endsWith('ui/OptionsModal.js')));
    assert.ok([...seen].some(f => f.endsWith('audio/SoundEngine.js')));
});

test('it works from any sub-path: nothing in the site refers to the site\u2019s own location', t => {
    const site = scratch(t);
    const bad = [];
    const walk = dir => {
        for (const entry of readdirSyncSafe(dir)) {
            const full = join(dir, entry);
            if (statIsDir(full)) { walk(full); continue; }
            if (!/\.(html|js|css)$/.test(entry)) continue;
            const text = readFileSync(full, 'utf8');
            if (/(?:href|src)=["']\/[^/]/.test(text)) bad.push(`${full}: root-absolute attribute`);
            if (/\bfetch\(\s*['"`]\//.test(text)) bad.push(`${full}: root-absolute fetch`);
            if (/location\.(pathname|origin)\s*[+=]/.test(text)) bad.push(`${full}: builds a URL from location`);
        }
    };
    walk(site);
    assert.deepEqual(bad, []);
});

// ------------------------------------------------------------ the verifier

test('verifySite reports a root-absolute URL', t => {
    const site = scratch(t);
    writeFileSync(join(site, 'index.html'), '<script type="module" src="/dist/src/main.js"></script>');
    const problems = verifySite(site);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /root-absolute/);
});

// Regression: CI (Linux) failed because this was decided by asking the OS whether the wrongly-cased path
// exists. That says yes on Windows/macOS and no on Linux, so the wording differed. It is now decided from
// directory listings, so these hold on every OS.
test('hasCaseMismatch separates "wrong capitalisation" from "does not exist", on any OS', t => {
    const site = scratch(t);
    assert.equal(hasCaseMismatch(site, 'styles.css'), false, 'exact name: no mismatch');
    assert.equal(hasCaseMismatch(site, 'Styles.css'), true, 'same name, different case');
    assert.equal(hasCaseMismatch(site, 'STYLES.CSS'), true);
    assert.equal(hasCaseMismatch(site, 'dist/SRC/main.js'), true, 'a directory segment can be the wrong case');
    assert.equal(hasCaseMismatch(site, 'dist/src/Main.js'), true);
    assert.equal(hasCaseMismatch(site, 'nothing-like-it.css'), false, 'missing outright is not a case problem');
    assert.equal(hasCaseMismatch(site, 'dist/nope/main.js'), false);
    assert.equal(hasCaseMismatch(site, 'styles.css/deeper'), false, 'a file used as a directory is not a case problem');
    assert.equal(existsExact(site, 'Styles.css'), false);
    assert.equal(existsExact(site, 'styles.css'), true);
});

test('verifySite reports wrong capitalisation, which only fails on case-sensitive hosts', t => {
    const site = scratch(t);
    writeFileSync(join(site, 'index.html'), '<link rel="stylesheet" href="./Styles.css"><script type="module" src="./dist/src/Main.js"></script>');
    const problems = verifySite(site);
    assert.equal(problems.length, 2);
    for (const problem of problems) assert.match(problem, /wrong capitalisation/);
});

test('verifySite reports a missing file, a bare import and an import with the wrong case', t => {
    const site = scratch(t);
    writeFileSync(join(site, 'dist/src/main.js'), "import './core/Nope.js';\nimport { x } from 'three';\nimport './core/engine.js';\nexport * from './core/PRNG.js';");
    const problems = verifySite(site);
    assert.equal(problems.length, 3);
    assert.ok(problems.some(p => /Nope\.js" does not exist/.test(p)));
    assert.ok(problems.some(p => /bare module name/.test(p)));
    assert.ok(problems.some(p => /engine\.js" has the wrong capitalisation/.test(p)));
});

test('verifySite reports a path that climbs out of the site, and a missing index', t => {
    const site = scratch(t);
    writeFileSync(join(site, 'dist/src/main.js'), "import '../../../outside.js';");
    assert.match(verifySite(site).join('\n'), /outside the site/);
    rmSync(join(site, 'index.html'));
    assert.match(verifySite(site).join('\n'), /index\.html is missing/);
});

test('verifySite allows deliberate external URLs, anchors, data URIs and query strings', t => {
    const site = scratch(t);
    writeFileSync(join(site, 'index.html'), [
        '<a href="https://example.com/x">x</a><a href="//cdn.example.com/y.js">y</a><a href="#top">t</a>',
        '<a href="mailto:a@b.c">m</a><img src="data:image/png;base64,AAAA">',
        '<link rel="stylesheet" href="./styles.css?v=3"><a href="./input-demo.html#lab">lab</a><a href="./">home</a>',
    ].join('\n'));
    assert.deepEqual(verifySite(site), []);
});

test('verifySite reads import forms the compiler emits: static, side-effect, re-export and dynamic', () => {
    const source = [
        "import { a } from './a.js';", "import b from \"./b.js\";", "import * as c from './c.js';", "import './d.js';",
        "export { e } from './e.js';", "export * from './f.js';", "const g = await import('./g.js');",
        "// import './commented.js' is still found: a comment is not special to the scanner",
        'const text = "not an import";',
    ].join('\n');
    const found = jsSpecifiers(source);
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) assert.ok(found.includes(`./${name}.js`), name);
    assert.equal(found.includes('not an import'), false);
});

test('existsExact is case-sensitive on every platform', t => {
    const site = scratch(t);
    assert.equal(existsExact(site, 'dist/src/main.js'), true);
    assert.equal(existsExact(site, 'dist/src/Main.js'), false);
    assert.equal(existsExact(site, 'Dist/src/main.js'), false);
    assert.equal(existsExact(site, 'dist/src/../src/main.js'), false, 'parent segments are not followed');
    assert.equal(existsExact(site, 'dist/src/main.js/x'), false);
    assert.equal(existsExact(site, './dist/./src/main.js'), true, 'current-directory segments are fine');
});

test('buildSite refuses to run before the TypeScript is built, or to overwrite the project', t => {
    const empty = mkdtempSync(join(tmpdir(), 'raid-empty-'));
    t.after(() => rmSync(empty, { recursive: true, force: true }));
    assert.throws(() => buildSite(empty, join(empty, '_site')), /npm run build/);
    assert.throws(() => buildSite(ROOT, ROOT), /must not be the project itself/);
    assert.throws(() => buildSite(ROOT, resolve(ROOT, '..')), /must not be the project itself or one of its parents/);
});

test('buildSite fails the build, listing every problem, if the result would be broken', t => {
    const root = mkdtempSync(join(tmpdir(), 'raid-root-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'dist', 'src'), { recursive: true });
    writeFileSync(join(root, 'dist', 'src', 'main.js'), "import './Missing.js';");
    writeFileSync(join(root, 'demo.html'), '<script type="module" src="/dist/src/main.js"></script>');
    writeFileSync(join(root, 'input-demo.html'), '<p>x</p>');
    writeFileSync(join(root, 'styles.css'), 'body{}');
    assert.throws(() => buildSite(root, join(root, '_site')), error => {
        assert.match(error.message, /has 3 problems/);
        assert.match(error.message, /root-absolute/);
        assert.match(error.message, /Missing\.js/);
        return true;
    });
});

test('a rebuild replaces the previous site completely', t => {
    const site = scratch(t);
    writeFileSync(join(site, 'stale.txt'), 'old');
    buildSite(ROOT, site);
    assert.equal(existsSync(join(site, 'stale.txt')), false);
    assert.deepEqual(verifySite(site), []);
});

// ------------------------------------------------------------------ workflow

test('the deploy workflow runs the specified steps in order and publishes with deploy-pages@v4', () => {
    const yml = read('.github', 'workflows', 'deploy.yml');
    const order = ['actions/checkout@', 'npm ci', 'npm run typecheck', 'npm test', 'npm run build', 'npm run build:pages', 'actions/upload-pages-artifact@', 'actions/deploy-pages@v4'];
    let at = -1;
    for (const needle of order) {
        const next = yml.indexOf(needle, at + 1);
        assert.ok(next > at, `"${needle}" is missing or out of order`);
        at = next;
    }
    assert.match(yml, /permissions:[\s\S]*pages: write[\s\S]*id-token: write/);
    assert.match(yml, /environment:\s*\n\s*name: github-pages/);
    assert.match(yml, /needs: build/);
    assert.match(yml, /branches: \[main\]/);
    assert.match(yml, /path: _site/);
    assert.match(yml, /cancel-in-progress: false/);
});

test('the workflow deploys only after every check has passed (one job builds, a second deploys)', () => {
    const yml = read('.github', 'workflows', 'deploy.yml');
    const deployJob = yml.slice(yml.indexOf('\n  deploy:'));
    assert.ok(deployJob.includes('actions/deploy-pages@v4'));
    assert.equal(deployJob.includes('npm test'), false);
    assert.ok(yml.slice(0, yml.indexOf('\n  deploy:')).includes('npm test'));
});

test('the workflow\u2019s Node version satisfies the toolchain', () => {
    const yml = read('.github', 'workflows', 'deploy.yml');
    const node = Number(/node-version:\s*(\d+)/.exec(yml)?.[1]);
    const needed = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'jsdom', 'package.json'), 'utf8')).engines.node;
    assert.ok(node >= 24 || /\^2[02]\./.test(needed) && node >= 20, `Node ${node} vs jsdom ${needed}`);
    assert.ok(node >= 20);
});
