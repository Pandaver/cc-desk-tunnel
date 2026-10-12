const { realpath } = require('node:fs/promises');

// A folder written by hand may be spelled in another case than it has on the disk, which macOS takes for the
// same folder. The spelling of the disk is the one used, so that one folder is one project in the list. A
// path that leads through a link stays as written, and so does one of Windows, compared without regard to
// case wherever it is used, and one of Linux, where another case is another folder.
async function asOnDisk(written) {
  if (process.platform !== 'darwin') return written;
  const key = (value) => value.normalize('NFC').toLowerCase().replace(/\/+$/, '');
  const found = await realpath(written).catch(() => written);
  return key(found) === key(written) ? found : written;
}
module.exports = { asOnDisk };
