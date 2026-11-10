// One start command for Mac, Windows and Linux: pick the Rive project, then run the helper.   node helper/start.js
const { spawnSync, spawn } = require('child_process'), path = require('path');
spawnSync(process.execPath, [path.join(__dirname, 'pick-project.js')], { stdio: 'inherit' });
console.log('Starting the helper. Keep this window open while you use the plugin.');
spawn(process.execPath, [path.join(__dirname, 'serve.js')], { stdio: 'inherit' }).on('exit', c => process.exit(c || 0));
