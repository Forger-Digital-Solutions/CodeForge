export const room = { widthCm:560, depthCm:520, heightCm:260, wallThicknessCm:20, floorThicknessCm:10, doorWidthCm:110, doorHeightCm:215, windowWidthCm:120, windowHeightCm:140, sillCm:90, sashTravelCm:65, playerRadiusCm:34, playerHalfHeightCm:88, attachmentToleranceCm:0.5 };

export function roomGeometry(s = room) {
  if (s.windowWidthCm!==120 || s.windowHeightCm!==140 || s.doorWidthCm!==110 || s.doorHeightCm!==215 || s.sashTravelCm!==65) throw new Error("R82 opening assets support only the certified door and sash dimensions");
  if (!Object.values(s).every(Number.isFinite) || s.widthCm<400 || s.depthCm<400 || s.heightCm<s.sillCm+s.windowHeightCm+10 || s.wallThicknessCm<=0 || s.floorThicknessCm<=0) throw new Error("Incompatible room dimensions");
  const box = (name,dims,material="plaster") => ({name,parts:[{dimensionsCm:dims,centerCm:[0,0,0],material}],collision:[{dimensionsCm:dims,centerCm:[0,0,0]}]});
  const front = (s.widthCm-s.doorWidthCm)/2, back = (s.widthCm-s.windowWidthCm)/2;
  const meshes = [
    box("SM_FrontWall",[front,s.wallThicknessCm,s.heightCm]),
    box("SM_DoorLintel",[s.doorWidthCm,s.wallThicknessCm,s.heightCm-s.doorHeightCm]),
    box("SM_SideWall",[s.wallThicknessCm,s.depthCm+2*s.wallThicknessCm,s.heightCm]),
    box("SM_BackWall",[back,s.wallThicknessCm,s.heightCm]),
    box("SM_WindowSillWall",[s.windowWidthCm,s.wallThicknessCm,s.sillCm]),
    box("SM_WindowHeader",[s.windowWidthCm,s.wallThicknessCm,s.heightCm-s.sillCm-s.windowHeightCm]),
    box("SM_Ceiling",[s.widthCm+2*s.wallThicknessCm,s.depthCm+2*s.wallThicknessCm,10],"wood"),
    box("SM_ExteriorFloor",[s.widthCm+2*s.wallThicknessCm,240,10],"wood"),
  ];
  const planks=[];
  for(let n=0;n<28;n++) planks.push({dimensionsCm:[s.widthCm/28-0.1,s.depthCm,s.floorThicknessCm],centerCm:[-s.widthCm/2+(n+0.5)*s.widthCm/28,0,0],material:"wood"});
  meshes.push({name:"SM_PlankFloor",parts:planks,collision:[{dimensionsCm:[s.widthCm,s.depthCm,s.floorThicknessCm],centerCm:[0,0,0]}]});
  const part = (d,c,material="wood") => ({dimensionsCm:d,centerCm:c,material});
  const frame=[part([5,16,140],[-57.5,0,70]),part([5,16,140],[57.5,0,70]),part([110,16,5],[0,0,2.5]),part([110,16,5],[0,0,137.5]),part([110,4,5],[0,3,72.5]),part([4,4,60],[0,3,105]),part([106,1,60],[0,3,105],"glass")];
  meshes.push({name:"SM_WindowFrame",parts:frame,collision:frame.map(({dimensionsCm,centerCm})=>({dimensionsCm,centerCm}))});
  const sash=[part([106,4,5],[0,-3,7.5]),part([106,4,5],[0,-3,67.5]),part([5,4,55],[-50.5,-3,37.5]),part([5,4,55],[50.5,-3,37.5]),part([3,4,55],[0,-3,37.5]),part([96,1,55],[0,-3,37.5],"glass")];
  meshes.push({name:"SM_WindowSash",parts:sash,collision:[{dimensionsCm:[106,4,65],centerCm:[0,-3,37.5]}]});
  return meshes;
}

export function roomBuilding(modules, id="western-room-a", offset=[0,0,0], s=room) {
  roomGeometry(s);
  const inst=(instanceId,name,positionCm)=>({instanceId,moduleId:modules.find(m=>m.engineAsset.endsWith('/'+name)).moduleId,moduleVersion:1,positionCm:positionCm.map((v,k)=>v+offset[k]),yawDeg:0,...(['door','window'].includes(instanceId)?{attachment:{instanceId:'floor',socketId:instanceId}}:{})});
  const front=(s.widthCm-s.doorWidthCm)/2,back=(s.widthCm-s.windowWidthCm)/2;
  return {schemaVersion:1,buildingInstanceId:id,attachmentToleranceCm:s.attachmentToleranceCm,instances:[
    inst("floor","SM_PlankFloor",[0,s.depthCm/2,-s.floorThicknessCm/2]),
    inst("front-left","SM_FrontWall",[-(s.doorWidthCm+front)/2,-s.wallThicknessCm/2,s.heightCm/2]),inst("front-right","SM_FrontWall",[(s.doorWidthCm+front)/2,-s.wallThicknessCm/2,s.heightCm/2]),
    inst("door-lintel","SM_DoorLintel",[0,-s.wallThicknessCm/2,(s.doorHeightCm+s.heightCm)/2]),
    inst("wall-left","SM_SideWall",[-s.widthCm/2-s.wallThicknessCm/2,s.depthCm/2,s.heightCm/2]),inst("wall-right","SM_SideWall",[s.widthCm/2+s.wallThicknessCm/2,s.depthCm/2,s.heightCm/2]),
    inst("back-left","SM_BackWall",[-(s.windowWidthCm+back)/2,s.depthCm+s.wallThicknessCm/2,s.heightCm/2]),inst("back-right","SM_BackWall",[(s.windowWidthCm+back)/2,s.depthCm+s.wallThicknessCm/2,s.heightCm/2]),
    inst("sill","SM_WindowSillWall",[0,s.depthCm+s.wallThicknessCm/2,s.sillCm/2]),inst("window-header","SM_WindowHeader",[0,s.depthCm+s.wallThicknessCm/2,(s.sillCm+s.windowHeightCm+s.heightCm)/2]),
    inst("ceiling","SM_Ceiling",[0,s.depthCm/2,s.heightCm+5]),inst("entrance-floor","SM_ExteriorFloor",[0,-120,-5]),
    inst("door","door_SM_DoorFrame",[0,-s.wallThicknessCm/2,0]),inst("window","SM_WindowFrame",[0,s.depthCm+s.wallThicknessCm/2,s.sillCm]),
  ]};
}
