import {cp,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.scratch'), pilot=path.join(root,'pilot');
try {await access(path.join(pilot,'DeadTrailsWest.uproject')); throw new Error('Pilot already exists; inspect it instead of overwriting');}
catch(e) {if(e.code!=='ENOENT') throw e;}
await mkdir(root,{recursive:true});
await cp('benchmarks/r82/project',pilot,{recursive:true});
await cp('benchmarks/r82/forge-gameplay-plugin',path.join(pilot,'Plugins/ForgeGameplay'),{recursive:true});
const ddc=path.join(root,'ddc').replaceAll('\\','/');
await mkdir(ddc,{recursive:true});
const local=`Local=(Type=FileSystem,ReadOnly=false,Clean=false,Flush=false,PurgeTransient=true,DeleteUnused=true,UnusedFileAge=34,FoldersToClean=-1,Path="${ddc}")`;
await writeFile(path.join(pilot,'Config/DefaultEngine.ini'),`[DerivedDataBackendGraph]\n${local}\n[InstalledDerivedDataBackendGraph]\n${local}\n[/Script/Engine.RendererSettings]\nr.DefaultFeature.AutoExposure=False\nr.DefaultFeature.MotionBlur=False\nr.DefaultFeature.Bloom=False\n`);
const descriptor=JSON.parse(await readFile(path.join(pilot,'DeadTrailsWest.uproject'),'utf8'));
descriptor.Description='ForgeAAA R82 isolated modular architecture test fixture';
await writeFile(path.join(pilot,'DeadTrailsWest.uproject'),JSON.stringify(descriptor,null,2));
console.log(pilot);
