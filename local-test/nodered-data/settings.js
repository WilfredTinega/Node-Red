// Minimal Node-RED settings for local testing. Logins come from the shared
// users.json through the adminAuth.js module the admin page keeps in /auth.
module.exports = {
    flowFile: 'flows.json',
    uiPort: 1880,
    adminAuth: require('/auth/adminAuth.js'),
    logging: { console: { level: "info", metrics: false, audit: false } },
};
