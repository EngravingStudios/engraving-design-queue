#!/usr/bin/env node
/* Usage: node hash-password.js 'your-chosen-password'
   Paste the output into config.json → auth.passwordHash            */
"use strict";
const bcrypt = require("bcryptjs");
const pw = process.argv[2];
if (!pw) {
  console.error("Usage: node hash-password.js 'your-chosen-password'");
  process.exit(1);
}
console.log(bcrypt.hashSync(pw, 10));
