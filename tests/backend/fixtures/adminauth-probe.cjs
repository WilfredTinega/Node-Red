// Loads a copy of adminAuth.js the way Node-RED's settings.js does (CommonJS)
// and prints what it answers for each [username, password] pair in argv.
'use strict';
const auth = require(process.argv[2]);
const pairs = JSON.parse(process.argv[3]);
(async () => {
  const out = { type: auth.type, results: [] };
  for (const [username, password] of pairs) {
    out.results.push({
      username,
      users: await auth.users(username),
      authenticate: await auth.authenticate(username, password),
    });
  }
  process.stdout.write(JSON.stringify(out));
})();
