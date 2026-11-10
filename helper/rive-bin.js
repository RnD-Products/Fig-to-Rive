// Finds the Rive CLI on any computer: RIVE_BIN, then ~/.rive/bin/rive (rive.exe on Windows), then "rive" on the PATH.
const fs = require('fs'), path = require('path'), os = require('os');
module.exports = function riveBin() {
  if (process.env.RIVE_BIN) return process.env.RIVE_BIN;
  const p = path.join(os.homedir(), '.rive', 'bin', 'rive' + (process.platform === 'win32' ? '.exe' : ''));
  return fs.existsSync(p) ? p : 'rive';
};
