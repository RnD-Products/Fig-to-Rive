const fs=require('fs'),path=require('path');
const {convert}=require('../plugin/convert.js');
const W=require('../plugin/webflow.js');
const [,,inFile,outDir,mode]=process.argv;
const res=convert(JSON.parse(fs.readFileSync(inFile,'utf8')),{name:'t'});
fs.mkdirSync(outDir,{recursive:true});
fs.writeFileSync(path.join(outDir,'scene.rml'),mode==='js'?W.apply(res.rml):res.rml);
fs.writeFileSync(path.join(outDir,'rive.yaml'),res.yaml);
