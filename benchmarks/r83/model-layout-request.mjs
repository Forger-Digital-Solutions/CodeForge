import { writeFile } from "node:fs/promises";
import { R82_ONE_ROOM_BUILDING as source, R83_TWO_ROOM_MODULES as after } from "../../packages/forge-aaa/dist/r83-building-spec.js";
export const modelRequest={model:"nvidia/nemotron-3-super-120b-a12b:free",temperature:0,maxTokens:12000,messages:[
  {role:"system",content:'Derive a UE4.27 modular building migration. Output only JSON {"removedInstanceIds":["wall-right"],"addedInstances":[...]}. Each added instance has instanceId,moduleId,moduleVersion:1,positionCm:[x,y,z],yawDeg and optional attachment:{instanceId,socketId}. Preserve existing native identities; never replace the original door/window. Calculate geometry from the input. No executable code. Emit compact JSON on one line, with all ten instances. Room B front and back both use SM_FrontWall_B; right wall center is X=870.'},
  {role:"user",content:JSON.stringify({request:"Expand Room A into connected Room B while preserving existing gameplay and SaveGame identities",source,modules:after.map(m=>({moduleId:m.moduleId,dimensions:m.dimensions,sockets:m.sockets,moduleType:m.moduleType})),constraints:{requiredIds:["floor-b","front-b","back-b","wall-right-b","ceiling-b","shared-wall-front","shared-wall-back","shared-wall-lintel","threshold","door-interior"],roomB:{center:[580,260,0],interior:[560,520,260]},sharedWall:{x:290,openingCenterY:260,openingWidth:110,openingHeight:215,thickness:20},interiorDoor:{positionCm:[290,260,0],yawDeg:90,attachment:{instanceId:"shared-wall-front",socketId:"door-int"}},floorTopZ:0,ceilingBottomZ:260,sharedWallFrontCenterY:92.5,sharedWallBackCenterY:427.5,roomBFrontY:-10,roomBBackY:530,roomBEastWallX:870}})},
]};
if(process.argv[1]?.endsWith("model-layout-request.mjs")) {
  await writeFile("docs/evidence/r83-forgeaaa-autonomous-multiroom/model-layout-request.json",JSON.stringify(modelRequest,null,2));
  console.log("Exact free-model request saved for review; no inference sent.");
}
