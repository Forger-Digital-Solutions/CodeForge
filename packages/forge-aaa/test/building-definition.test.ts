import { describe, it, expect } from "vitest";
import { validateBuildingDefinition, type BuildingModuleDefinition } from "../src/building-definition.js";
import { architecturalBlenderScript } from "../src/architectural-template.js";

const module: BuildingModuleDefinition = { contractVersion:1,moduleVersion:1,moduleId:"forge/wall/v1",moduleType:"wall",displayName:"Wall",dimensions:{widthCm:200,depthCm:20,heightCm:260},pivot:{kind:"center"},sockets:[{id:"end",localPosCm:[200,0,0],accepts:["wall"]}],collision:{profile:"block-all"},provenance:{authoredBy:"deterministic"},engines:{unreal:["4.27"]},sourceAsset:"wall.fbx",engineAsset:"/Game/ForgeAAA/R82/SM_Wall",coordinateSystem:"unreal-cm-z-up",materials:["plaster"],dependencies:[],validationStatus:"geometry-verified" };
const building = () => ({schemaVersion:1,buildingInstanceId:"house-a",attachmentToleranceCm:0.5,instances:[{instanceId:"wall-a",moduleId:module.moduleId,moduleVersion:1,positionCm:[0,0,0],yawDeg:0},{instanceId:"wall-b",moduleId:module.moduleId,moduleVersion:1,positionCm:[200,0,0],yawDeg:0,attachment:{instanceId:"wall-a",socketId:"end"}}]});

describe("building assembly validation",()=>{
 it("accepts compatible touching modules and returns an isolated copy",()=>{const b=building();const result=validateBuildingDefinition(b,[module]); expect(result).toEqual(b); expect(result).not.toBe(b);});
 it.each(["duplicate","missing","nan","overlap","socket","misaligned","version","cycle"])("rejects %s before placement",(defect)=>{
  const b=building();
  if(defect==="duplicate") b.instances[1]!.instanceId="wall-a";
  if(defect==="missing") b.instances[1]!.moduleId="missing";
  if(defect==="nan") b.instances[0]!.positionCm[0]=NaN;
  if(defect==="overlap") {b.instances[1]!.positionCm[0]=10;delete b.instances[1]!.attachment;}
  if(defect==="socket") b.instances[1]!.attachment!.socketId="missing";
  if(defect==="misaligned") b.instances[1]!.positionCm[0]=210;
  if(defect==="version") b.instances[0]!.moduleVersion=2;
  if(defect==="cycle") b.instances[0]!.attachment={instanceId:"wall-b",socketId:"end"};
  expect(()=>validateBuildingDefinition(b,[module])).toThrow();
 });
 it("rejects unauthorized assets, unsupported types, and unresolved dependencies",()=>{
  for(const patch of [{engineAsset:"/Game/UserOwned/Wall"},{moduleType:"stair"},{dependencies:["missing"]},{moduleVersion:2},{contentSha256:"wrong"}]) expect(()=>validateBuildingDefinition(building(),[{...module,...patch} as BuildingModuleDefinition])).toThrow();
 });
 it("does not mutate a rejected building",()=>{const b=building();b.instances[1]!.positionCm[0]=1;const copy=structuredClone(b);expect(()=>validateBuildingDefinition(b,[module])).toThrow();expect(b).toEqual(copy);});
 it("rejects missing identities without coercing undefined to a string",()=>{
  const b=building();
  expect(()=>validateBuildingDefinition({...b,buildingInstanceId:undefined},[module])).toThrow();
  expect(()=>validateBuildingDefinition({...b,instances:[{...b.instances[0],instanceId:undefined}]},[module])).toThrow();
 });
 it("rejects unsupported pivots and engine metadata",()=>{
  expect(()=>validateBuildingDefinition(building(),[{...module,pivot:{kind:"corner"}}])).toThrow();
  expect(()=>validateBuildingDefinition(building(),[{...module,engines:{unreal:["5.0"]}}])).toThrow();
 });
 it("rejects unbounded geometry and malformed collision proxies",()=>{
  expect(()=>architecturalBlenderScript([{name:"SM_Wall",parts:[{dimensionsCm:[Infinity,20,260],centerCm:[0,0,0],material:"wood"}],collision:[]}])).toThrow();
 });
});
