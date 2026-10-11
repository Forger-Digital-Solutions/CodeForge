import { describe,it,expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UnrealAdapter, type UnrealCommandletRequest } from "../src/adapters/unreal.js";

describe("native evidence fails closed",()=>{
 it.each(["missing-pass","wrong-index","wrong-operation","window-state","success","missing-capture","crashed-process"])("evaluates %s from measured records",async(mode)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"r82-native-"));
  class Adapter extends UnrealAdapter {
   override async runCommandlet(req:UnrealCommandletRequest) {
    const spec=JSON.parse(await fs.readFile(path.join(dir,"spec.json"),"utf8")) as {runId:string};
    const record={index:mode==="wrong-index"?10:0,op:mode==="wrong-operation"?"wait":mode==="missing-capture"?"screenshot":"expectWindow",...(mode!=="missing-pass"&&mode!=="missing-capture"?{pass:true}:{}),restored:true};
    const slot={index:1,op:"slotVerify",windows:{one:{state:mode==="window-state"?0:2}}};
    await fs.writeFile(path.join(dir,"report.json"),JSON.stringify({runId:spec.runId,executed:true,actions:[record,slot],errors:[]}));
    expect(req.args).toContain("-ForgeSaveSlot=ForgeR82InteriorTest");
    return {ok:mode!=="crashed-process",exitCode:mode==="crashed-process"?3:0,timedOut:false,durationMs:1,logTail:""};
   }
  }
  try {
   const result=await new Adapter().runNativeGameplayTest({projectPath:path.join(dir,"pilot.uproject"),levelPath:"/Game/ForgeAAA/Maps/R82",specPath:path.join(dir,"spec.json"),reportPath:path.join(dir,"report.json"),saveSlot:"ForgeR82InteriorTest",actions:[mode==="missing-capture"?{op:"screenshot",screenshotPath:path.join(dir,"missing.png")}:{op:"expectWindow",window:"one",state:"open",expect:{restored:true}},{op:"slotVerify",expect:{windowStates:{one:2}}}]});
   expect(result.state).toBe(mode==="success"?"pass":"fail");
  } finally {await fs.rm(dir,{recursive:true,force:true});}
 });
});
