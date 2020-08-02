const fs = require('fs');
const path = require('path');
const glob = require('glob');
const {promisify} = require('util');

/**
 * Check if the current running node version supports import statements.
 * Node doesn't have a native way to check for this.
 */
async function supportsImports() {
    let canUseImport = true;
    try {
        await import('./file-that-does-not-exist');
    } catch (err) {
        if (/Not\ssupported/.test(err.message)) {
            canUseImport = false;
        }
    }

    return canUseImport;
}

let canUseImport;

/**
 * Load module via CommonJS or ES Modules depending on the environment
 * @param {string} file
 */
async function importFile(file) {
    if (canUseImport === undefined) {
        canUseImport = await supportsImports();
    }

    if (canUseImport) {
        // Use dynamic import statement to be able to load both native esm
        // and commonjs modules.
        const m = await import(file);

        // If we're importing a commonjs file the exports will be defined
        // as an esm default export
        return m.default ? m.default : m;
    } else {
        return require(file);
    }
}

/**
 * @typedef {Omit<import('./runner').TestCase, 'name' | 'run'>} TestOptions
 */

/**
 * @typedef {{(name: string, test: (config: import('./runner').TaskConfig) => Promise<void> | void, options?: TestOptions): void, only: (name: string, test: (config: import('./runner').TaskConfig) => Promise<void> | void, options?: TestOptions): void} TestFn
 */

/**
 * @typedef {{(name: string, callback: () => void): void, only: (name: string, callback: () => void): void} SuiteFn
 */

/**
 * @param {string} suiteName
 * @param {(test: TestFn, suite: SuiteFn) => void} builder
 * @private
 */
function loadSuite(suiteName, builder) {
    const tests = [];
    const only = [];
    let onlyInScope = false;
    const groups = [suiteName];
    let i = 0;

    /**
     * @param {string} description
     * @param {(config: import('./config').Config) => Promise<void>} run
     * @param {{ skip: () => Promise<boolean> | boolean}} options
     */
    function test(description, run, options = {}) {
        const arr = onlyInScope ? only : tests;
        arr.push({
            description,
            name: `${groups.join('>')}_${i++}`,
            run,
            ...options,
        });
    }

    test.only = (description, run, options = {}) => {
        only.push({
            description,
            name: `${groups.join('>')}_${i++}`,
            run,
            ...options,
        });
    };

    function suite(description, callback) {
        groups.push(description);
        callback();
        groups.pop();
    }

    suite.only = (description, callback) => {
        onlyInScope = true;
        groups.push(description);

        callback();

        onlyInScope = false;
        groups.pop();
    };

    builder(test, suite);
    return only.length > 0 ? only : tests;
}

/**
 * @param {*} args
 * @param {string} testsDir
 * @param {string} [globPattern]
 * @private
 */
async function loadTests(args, testsDir, globPattern = '*.{js,cjs,mjs}') {
    const testFiles = await promisify(glob.glob)(globPattern, {cwd: testsDir});
    let tests = testFiles.map(n => ({
        path: n,
        name: path.basename(n, path.extname(n)),
    }));

    if (args.filter) {
        tests = tests.filter(n => new RegExp(args.filter).test(n.name));
    }
    if (args.filter_body) {
        const bodyFilterRe = new RegExp(args.filter_body);
        tests = (await Promise.all(tests.map(async test => {
            const filePath = path.join(testsDir, test.path);
            const contents = await promisify(fs.readFile)(filePath, {encoding: 'utf-8'});
            return bodyFilterRe.test(contents) ? test : null;
        }))).filter(t => t);
    }

    const testCases = [];
    await Promise.all(
        tests.map(async t => {
            const file = path.join(testsDir, t.path);

            let tc = await importFile(file);

            if (typeof tc.runSuite === 'function') {
                testCases.push(...loadSuite(t.name, tc.runSuite));
            } else {
                // ESM modules are readonly, so we need to create our own writable
                // object.
                testCases.push({...tc, name: t.name});
            }
        })
    );

    return testCases;
}

module.exports = {
    importFile,
    loadTests,
    supportsImports,
};
