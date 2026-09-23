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

// bcryptjs ships with Node-RED; find it next to whichever Node-RED is running.
const bcrypt = require(require.resolve('bcryptjs', {
    paths: [path.dirname(require.main ? require.main.filename : __dirname), '/usr/src/node-red'],
}));

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
    return u.instances[INSTANCE] || null;
}

function profile(u) {
    const permissions = accessHere(u);
    return permissions ? { username: u.username, permissions: permissions } : null;
}

module.exports = {
    type: 'credentials',
    users: function (username) {
        return Promise.resolve(profile(findUser(username)));
    },
    authenticate: function (username, password) {
        const u = findUser(username);
        const ok = u && typeof u.password === 'string' &&
            bcrypt.compareSync(password, u.password.replace(/^\$2y\$/, '$2a$'));
        return Promise.resolve(ok ? profile(u) : null);
    },
};
