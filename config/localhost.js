// .js files can run arbitrary JavaScript code.

// Just export the configuration:
module.exports = {
    extends: '_common',

    pentf_boot_lockserver: false,
    external_locking_url: 'http://localhost:1524/pentf-localhost',
    pentf_lockserver_url: 'http://localhost:1524/pentf-internal',
};
