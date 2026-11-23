// Card P3c review: preloaded with --require, it records every node:sqlite DatabaseSync the
// process constructs (its path and whether it is read-only) as one JSON line in the file
// named by P3C_OPEN_LOG, so a test can count the CLI's connections at run time.
'use strict';
const { appendFileSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const sqlite = require('node:sqlite');

const Original = sqlite.DatabaseSync;
sqlite.DatabaseSync = class CountedDatabaseSync extends Original {
  constructor(path, options) {
    appendFileSync(process.env.P3C_OPEN_LOG, JSON.stringify({ path: String(path), readOnly: options?.readOnly === true }) + '\n');
    super(path, options);
  }
};
// ES module imports of node:sqlite see the replacement too.
syncBuiltinESMExports();
