// Node-RED login backed by the shared users.json that the Node-RED admin page manages.
// The admin page copies this file next to users.json on every start, so edit
// the copy in the admin page's source (nodered/adminAuth.js), not this one.
//
// In each Node-RED's settings.js:
//     adminAuth: require('/auth/adminAuth.js'),          // Docker (/auth mounted)
//     adminAuth: require('/opt/nodered-auth/adminAuth.js'), // installed on the host
//
// Each instance must know its own key (the port shown on the admin page):
//   Docker:        environment NODERED_INSTANCE=<host port>, e.g. 1880
//   host install:  nothing to do if it listens on PORT or 1880; otherwise set NODERED_INSTANCE
'use strict';
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');
const INSTANCE = process.env.NODERED_INSTANCE || String(process.env.PORT || 1880);

// In a container the fallback key (1880) is the container-side port, which is
// not the host port the dashboard uses. Rather than let a user limited to
// instances in through a wrong key, refuse them until NODERED_INSTANCE is set.
// (The file to check can be pointed elsewhere for tests.)
const IN_DOCKER = fs.existsSync(process.env.ADMINAUTH_DOCKERENV_FILE || '/.dockerenv');
const KEY_UNKNOWN = IN_DOCKER && !process.env.NODERED_INSTANCE;
if (KEY_UNKNOWN) {
    console.warn('adminAuth: NODERED_INSTANCE is not set. Set it to this container\'s host port ' +
        '(the key the admin page shows), or users limited to instances cannot log in here.');
}

// bcryptjs ships with Node-RED; find it next to whichever Node-RED is running.
// require.main is Node-RED's red.js normally, but it is a process manager's
// wrapper under pm2 and missing when an ES module loads this file, so the
// started script, the working folder and this folder are tried too.
function loadBcrypt() {
    const bases = [
        require.main && require.main.filename,
        process.argv[1],
        path.join(process.cwd(), 'x'),
        __filename,
        '/usr/src/node-red/x',
    ].filter(Boolean).map((f) => path.dirname(f));
    for (const base of bases) {
        try {
            return require(require.resolve('bcryptjs', { paths: [base] }));
        } catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND') throw e;
        }
    }
    throw new Error('adminAuth: cannot find bcryptjs (looked from ' + bases.join(', ') + ')');
}
const bcrypt = loadBcrypt();

function findUser(name) {
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).find((u) => u.username === name) || null;
    } catch (e) {
        console.error('adminAuth: cannot read ' + USERS_FILE + ': ' + e.message);
        return null;
    }
}

// A user without an `instances` map gets their main access everywhere.
// With a map, instances not listed refuse the login.
function accessHere(u) {
    if (!u) return null;
    if (!u.instances) return u.permissions;
    if (KEY_UNKNOWN) return null;
    return Object.prototype.hasOwnProperty.call(u.instances, INSTANCE) ? u.instances[INSTANCE] || null : null;
}

function profile(u) {
    const permissions = accessHere(u);
    return permissions ? { username: u.username, permissions: permissions } : null;
}

module.exports = {
    type: 'credentials',
    // Node-RED keeps a session's permissions until it expires (7 days by
    // default), so a change on the admin page took up to a week to bite.
    sessionExpiryTime: 8 * 60 * 60,
    users: function (username) {
        return Promise.resolve(profile(findUser(username)));
    },
    authenticate: function (username, password) {
        const u = findUser(username);
        const ok = u && typeof u.password === 'string' && typeof password === 'string' &&
            bcrypt.compareSync(password, u.password.replace(/^\$2y\$/, '$2a$'));
        return Promise.resolve(ok ? profile(u) : null);
    },
};
