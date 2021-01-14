const fs = require('fs');
const path = require('path');
const glob = require('glob');
const {promisify} = require('util');
const {pathToFileURL} = require('url');
const assert = require('assert').strict;
const output = require('./output');

/**
 * Find nearest `package.json` file
 * @param {string} dir
 * @returns {string | null} Path to package.json or null if not found
 */
async function findPackageJson(dir) {
    let fileName = path.join(dir, 'package.json');
    try {
        await fs.promises.readFile(fileName);
        return fileName;
    } catch(e) {
        // File doesn't exist, traverse upwards
        if (e.code === 'ENOENT' && dir !== path.dirname(dir)) {
            return await findPackageJson(path.dirname(dir));
        }
    }

    return null;
}

/**
 * Will be set during compilation. Prevents ESM modules trying to use
 * `require` for loading modules
 */
const BUILD_TYPE = 'commonjs';

/**
 * Load module via CommonJS or ES Modules depending on the environment
 * @param {string} file
 * @param {"commonjs" | "module"} moduleType
 */
async function importFile(file, moduleType) {
    assert(moduleType, 'Module type argument was undefined. Expected "commonjs" or "esm"');
    // Only use import() for JavaScript files. Patching module
    // resolution of import() calls is still very experimental, so
    // tools like `ts-node´ need to keep using `require` calls.
    // Note that we still need to forward loading from `node_modules`
    // to `import()` regardless.
    if (BUILD_TYPE === 'module' || moduleType === 'esm' || /\.mjs$/.test(file)) {
        // Use dynamic import statement to be able to load both native esm
        // and commonjs modules.

        // If we have a an absolute path we need to convert it to a URL.
        // This is crucial for Windows support where paths are not valid
        // URL pathnames. The latter is supported by `import()` out of
        // the box.
        let urlOrModuleName = file;
        if (path.isAbsolute(file)) {
            urlOrModuleName = pathToFileURL(file).href;
        }

        const m = await import(urlOrModuleName);

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
 * @typedef {{}} TestFn
 */

/**
 * @typedef {{}} DescribeFn
 */

/**
 * @typedef {(test: TestFn, suite: DescribeFn) => void} SuiteBuilder
 */

/**
 * @param {string} fileName
 * @param {string} suiteName
 * @param {SuiteBuilder} builder
 * @private
 */
function loadSuite(fileName, suiteName, builder) {
    const tests = [];
    const only = [];
    let onlyInScope = false;
    let skipInScope = false;
    const groups = [suiteName];
    let i = 0;

    const skipFn = () => true;

    /**
     * Create a test case
     * @param {string} description
     * @param {(config: import('./config').Config) => Promise<void>} run
     * @param {TestOptions} options
     */
    function test(description, run, options = {}) {
        const arr = onlyInScope ? only : tests;
        arr.push({
            description,
            name: `${groups.join('>')}_${i++}`,
            run,
            skip: skipInScope ? skipFn : options.skip,
            path: fileName,
            ...options,
        });
    }

    /**
     * Only run this test case in the current file
     * @param {string} description
     * @param {(config: import('./config').Config) => Promise<void>} run
     * @param {TestOptions} options
     */
    test.only = (description, run, options = {}) => {
        only.push({
            description,
            name: `${groups.join('>')}_${i++}`,
            run,
            skip: skipInScope ? skipFn : options.skip,
            path: fileName,
            ...options,
        });
    };

    /**
     * Skip this test case
     * @param {string} description
     * @param {(config: import('./config').Config) => Promise<void>} run
     * @param {TestOptions} options
     */
    test.skip = (description, run, options = {}) => {
        const arr = onlyInScope ? only : tests;
        arr.push({
            description,
            name: `${groups.join('>')}_${i++}`,
            run,
            skip: skipFn,
            path: fileName,
            ...options,
        });
    };

    /**
     * Create a group for test cases
     * @param {string} description
     * @param {() => void} callback
     */
    function describe(description, callback) {
        groups.push(description);
        callback();
        groups.pop();
    }

    /**
     * Only run the test cases inside this group
     * @param {string} description
     * @param {() => void} callback
     */
    describe.only = (description, callback) => {
        onlyInScope = true;
        groups.push(description);

        callback();

        onlyInScope = false;
        groups.pop();
    };

    /**
     * Skip this group of test cases
     * @param {string} description
     * @param {() => void} callback
     */
    describe.skip = (description, callback) => {
        skipInScope = true;
        groups.push(description);

        callback();

        skipInScope = false;
        groups.pop();
    };

    builder(test, describe);
    return only.length > 0 ? only : tests;
}

/**
 * @param {import('./config').Config} config
 * @param {Array<{name: string, fileName: string}>} tests
 */
async function applyTestFilters(config, tests) {
    if (config.filter) {
        tests = tests.filter(n => new RegExp(config.filter).test(n.name));
    }
    if (config.filter_body) {
        const bodyFilterRe = new RegExp(config.filter_body);
        tests = (await Promise.all(tests.map(async test => {
            const contents = await fs.promises.readFile(test.fileName, {encoding: 'utf-8'});
            return bodyFilterRe.test(contents) ? test : null;
        }))).filter(t => t);
    }

    return tests;
}

/**
 * @param {import('./config').Config} config
 * @param {string} globPattern
 * @returns {Promise<import('./runner').TestCase[]>}
 * @private
 */
async function loadTests(config, globPattern) {
    const testFiles = await promisify(glob.glob)(globPattern, {cwd: config.rootDir, absolute: true});
    let tests = testFiles.map(n => ({
        fileName: n,
        name: path.basename(n, path.extname(n)),
    }));

    tests = await applyTestFilters(config, tests);

    const testCases = [];
    await Promise.all(
        tests.map(async t => {
            let tc = await importFile(t.fileName, config.moduleType);

            if (typeof tc.suite === 'function') {
                testCases.push(...loadSuite(t.fileName, t.name, tc.suite));
            } else if (typeof tc.run === 'function') {
                // ESM modules are readonly, so we need to create our own writable
                // object.
                testCases.push({...tc, name: t.name, fileName: t.fileName});
            } else {
                output.log(config, output.color(config, 'red', `No tests found in file "${t.fileName}", skipping.`));
            }
        })
    );

    return testCases;
}

module.exports = {
    applyTestFilters,
    findPackageJson,
    importFile,
    loadTests,
};
