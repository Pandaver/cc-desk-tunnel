const { appendFileSync, mkdirSync, renameSync, statSync } = require('node:fs');
const path = require('node:path');

// The client's own record of its connections: when each began, how it went and why it ended. It is there to tell
// a fault of the network from one of this program, on the computer where it happened. No token, message or
// command is written to it. Two files of about a megabyte are kept.
const LIMIT = 1024 * 1024;
function openLog(directory) {
  const file = path.join(directory, 'client.log');
  return {
    directory,
    write(text) {
      try {
        mkdirSync(directory, { recursive: true });
        try {
          if (statSync(file).size > LIMIT) renameSync(file, path.join(directory, 'client.1.log'));
        } catch {}
        const line = String(text).replace(/\s+/g, ' ').trim().slice(0, 500);
        appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
      } catch {}
    },
  };
}
module.exports = { openLog };
