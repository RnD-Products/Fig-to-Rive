#!/usr/bin/env node
// Run by "Start Helper.command" before the helper starts: signs in to Rive if needed and makes sure
// config.json points at a Rive project that YOUR account can create files in (asks only if it must).
const fs = require('fs'), path = require('path'), os = require('os'), readline = require('readline');
const { spawnSync } = require('child_process');
const RIVE = require('./rive-bin')();
const CONFIG = path.join(__dirname, '..', 'config.json');
const strip = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const rive = (args, inherit) => { const r = spawnSync(RIVE, args, inherit ? { stdio: 'inherit' } : { encoding: 'utf8' }); return strip((r.stdout || '') + '\n' + (r.stderr || '')); };
const ask = q => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); res(a.trim()); }); });

(async () => {
  if (!fs.existsSync(RIVE)) { console.log('The Rive CLI is not installed. Run ./scripts/setup.sh first.'); return; }
  const signedIn = () => !/not logged in/i.test(rive(['whoami']).split('\n').filter(l => !/is available/i.test(l))[0] || 'Not logged in');
  if (!signedIn()) {
    console.log('You are not signed in to Rive. Opening the sign-in now (it uses your browser)...');
    rive(['login'], true);
    if (!signedIn()) { console.log('Still not signed in. Pushing will not work until you run:  rive login'); return; }
  }
  const projects = [...rive(['push', '--list']).matchAll(/^\s*\d+\)\s+(\d+)\s+(.+?)\s*$/gm)].map(m => ({ id: +m[1], name: m[2] }));
  if (!projects.length) { console.log('No Rive projects found on this account, so pushing is not set up. Create one in Rive first.'); return; }
  const cfg = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
  let pick = projects.find(p => p.id === cfg.projectId);
  if (!pick) {
    if (projects.length === 1) pick = projects[0];
    else {
      console.log('\nWhich Rive project should pushes go to?');
      projects.forEach((p, i) => console.log('  ' + (i + 1) + ') ' + p.name));
      for (let tries = 0; !pick && tries < 3; tries++) pick = projects[+(await ask('Type a number: ')) - 1];
      if (!pick) { console.log('No project chosen. Pushing will not work until you pick one.'); return; }
    }
    cfg.projectId = pick.id; fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  }
  console.log('Pushes go to Rive project: ' + pick.name);
})();
