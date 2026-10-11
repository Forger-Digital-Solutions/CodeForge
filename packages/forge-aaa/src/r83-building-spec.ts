import type { BuildingDefinition, BuildingModuleDefinition } from "./building-definition.js";
import type { ConnectedBuildingDefinition } from "./connected-building.js";

// Exact published R82 contracts retain their asset hashes and provenance.
export const R82_ONE_ROOM_MODULES: BuildingModuleDefinition[] = [
  {
    "contractVersion": 1,
    "moduleVersion": 1,
    "moduleId": "forge/building/SM_FrontWall/v1",
    "moduleType": "wall",
    "displayName": "SM_FrontWall",
    "dimensions": {
      "widthCm": 225,
      "depthCm": 20,
      "heightCm": 260
    },
    "pivot": {
      "kind": "center"
    },
    "sockets": [],
    "collision": {
      "profile": "block-all"
    },
    "provenance": {
      "authoredBy": "deterministic"
    },
    "engines": {
      "unreal": [
        "4.27"
      ],
      "blender": [
        "4.5"
      ]
    },
    "sourceAsset": "architecture/SM_FrontWall.fbx",
    "engineAsset": "/Game/ForgeAAA/R82/SM_FrontWall",
    "coordinateSystem": "unreal-cm-z-up",
    "materials": [
      "Forge_plaster"
    ],
    "dependencies": [],
    "validationStatus": "geometry-verified",
    "contentSha256": "efdfc5387140eaf6fe1160e89d542fafc8e6adc800026a12a2f6dc576a476ff3"
  },
  {
    "contractVersion": 1,
    "moduleVersion": 1,
    "moduleId": "forge/building/SM_DoorLintel/v1",
    "moduleType": "wall",
    "displayName": "SM_DoorLintel",
    "dimensions": {
      "widthCm": 110,
      "depthCm": 20,
      "heightCm": 45
    },
    "pivot": {
      "kind": "center"
    },
    "sockets": [],
    "collision": {
      "profile": "block-all"
    },
    "provenance": {
      "authoredBy": "deterministic"
    },
    "engines": {
      "unreal": [
        "4.27"
      ],
      "blender": [
        "4.5"
      ]
    },
    "sourceAsset": "architecture/SM_DoorLintel.fbx",
    "engineAsset": "/Game/ForgeAAA/R82/SM_DoorLintel",
    "coordinateSystem": "unreal-cm-z-up",
    "materials": [
      "Forge_plaster"
    ],
    "dependencies": [],
    "validationStatus": "geometry-verified",
    "contentSha256": "a7bebccc3c0a8b9086c520d9396963500e6f4c2f17f59c3b4a50226a7b991670"
  },
  {
    "contractVersion": 1,
    "moduleVersion": 1,
    "moduleId": "forge/building/SM_SideWall/v1",
    "moduleType": "wall",
    "displayName": "SM_SideWall",
    "dimensions": {
      "widthCm": 20,
      "depthCm": 560,
      "heightCm": 260
    },
    "pivot": {
      "kind": "center"
    },
    "sockets": [],
    "collision": {
      "profile": "block-all"
    },
    "provenance": {
      "authoredBy": "deterministic"
    },
    "engines": {
      "unreal": [
        "4.27"
      ],
      "blender": [
        "4.5"
      ]
    },
    "sourceAsset": "architecture/SM_SideWall.fbx",
    "engineAsset": "/Game/ForgeAAA/R82/SM_SideWall",
    "coordinateSystem": "unreal-cm-z-up",
    "materials": [
      "Forge_plaster"
    ],
    "dependencies": [],
    "validationStatus": "geometry-verified",
    "contentSha256": "c6767518e131cdfcd6edb1702164029d9b2707b4ca2b2f106a08b346ababb968"
  },
  {
    "contractVersion": 1,
    "moduleVersion": 1,
    "moduleId": "forge/building/SM_BackWall/v1",
    "moduleType": "wall",
    "displayName": "SM_BackWall",
    "dimensions": {
      "widthCm": 220,
      "depthCm": 20,
      "heightCm": 260
    },
    "pivot": {
      "kind": "center"
    },
    "sockets": [],
    "collision": {
      "profile": "block-all"
    },
    "provenance": {
      "authoredBy": "deterministic"
    },
    "engines": {
      "unreal": [
        "4.27"
      ],
      "blender": [
        "4.5"
      ]
    },
    "sourceAsset": "architecture/SM_BackWall.fbx",
    "engineAsset": "/Game/ForgeAAA/R82/SM_BackWall",
    "coordinateSystem": "unreal-cm-z-up",
    "materials": [
      "Forge_plaster"
    ],
    "dependencies": [],
    "validationStatus": "geometry-verified",
    "contentSha256": "c7ab5b1c63cd686bb527d062e5592e26ffdda38e2127dc5330e25ac69aec2af6"
  },
  {
    "contractVersion": 1,
    "moduleVersion": 1,
    "moduleId": "forge/building/SM_WindowSillWall/v1",
    "moduleType": "wall",
    "displayName": "SM_WindowSillWall",
    "dimensions": {
      "widthCm": 120.00000762939453,
      "depthCm": 20,
      "heightCm": 90
    },
    "pivot": {
      "kind": "center"
    },
    "sockets": [],
    "collision": {
      "profile": "block-all"
    },
    "provenance": {
      "authoredBy": "deterministic"
    },
    "engines": {
      "unreal": [
        "4.27"
      ],
      "blender": [
        "4.5"
      ]
    },
    "sourceAsset": "architecture/SM_WindowSillWall.fbx",
    "engineAsset": "/Game/ForgeAAA/R82/SM_WindowSillWall",
    "coordinateSystem": "unreal-cm-z-up",
    "materials": [
      "Forge_plaster"
    ],
    "dependencies": [],
    "validationStatus": "geometry-verified",
    "contentSha256": "b3a15baba9d449e9362158f30b647a4eb30f8afc3726b9fb58ea348acbd11499"
  },
  {
    "contractVersion": 1,
    "moduleVersion": 1,
    "moduleId": "forge/building/SM_WindowHeader/v1",
    "moduleType": "wall",
    "displayName": "SM_WindowHeader",
    "dimensions": {
      "widthCm": 120.00000762939453,
      "depthCm": 20,
      "heightCm": 30.000001907348633
    },
    "pivot": {
      "kind": "center"
    },
    "sockets": [],
    "collision": {
      "profile": "block-all"
    },
    "provenance": {
      "authoredBy": "deterministic"
    },
    "engines": {
      "unreal": [
        "4.27"
      ],
      "blender": [
        "4.5"
      ]
    },
    "sourceAsset": "architecture/SM_WindowHeader.fbx",
    "engineAsset": "/Game/ForgeAAA/R82/SM_WindowHeader",
    "coordinateSystem": "unreal-cm-z-up",
    "materials": [
      "Forge_plaster"
    ],
    "dependencies": [],
    "validationStatus": "geometry-verified",
    "contentSha256": "978ba0d8dd889d5cf37201a6a9376ba6e9e0d5361fc2c12eca303ff78bf4e46d"
  },
  {
    "contractVersion": 1,
    "moduleVersion": 1,
    "moduleId": "forge/building/SM_Ceiling/v1",
    "moduleType": "roof",
    "displayName": "SM_Ceiling",
    "dimensions": {
      "widthCm": 600,
      "depthCm": 560,
      "heightCm": 10
    },
    "pivot": {
      "kind": "center"
    },
    "sockets": [],
    "collision": {
      "profile": "block-all"
    },
    "provenance": {
      "authoredBy": "deterministic"
    },
    "engines": {
      "unreal": [
        "4.27"
      ],
      "blender": [
        "4.5"
      ]
    },
    "sourceAsset": "architecture/SM_Ceiling.fbx",
    "engineAsset": "/Game/ForgeAAA/R82/SM_Ceiling",
    "coordinateSystem": "unreal-cm-z-up",
    "materials": [
      "Forge_wood"
    ],
    "dependencies": [],
    "validationStatus": "geometry-verified",
    "contentSha256": "70a440f591d4d2353027a93846507e7fa645d8eb19c7bdbe117cff70b8114b7c"
  },
  {
    "contractVersion": 1,
    "moduleVersion": 1,
    "moduleId": "forge/building/SM_ExteriorFloor/v1",
    "moduleType": "floor",
    "displayName": "SM_ExteriorFloor",
    "dimensions": {
      "widthCm": 600,
      "depthCm": 240.00001525878906,
      "heightCm": 10
    },
    "pivot": {
      "kind": "center"
    },
    "sockets": [],
    "collision": {
      "profile": "block-all"
    },
    "provenance": {
      "authoredBy": "deterministic"
    },
    "engines": {
      "unreal": [
        "4.27"
      ],
      "blender": [
        "4.5"
      ]
    },
    "sourceAsset": "architecture/SM_ExteriorFloor.fbx",
    "engineAsset": "/Game/ForgeAAA/R82/SM_ExteriorFloor",
    "coordinateSystem": "unreal-cm-z-up",
    "materials": [
      "Forge_wood"
    ],
    "dependencies": [],
    "validationStatus": "geometry-verified",
    "contentSha256": "f3f99a788da07d2891e6afe9948007a8884fceff6800fa7f5a0ce8112c3571c4"
  },
  {
    "contractVersion": 1,
    "moduleVersion": 1,
    "moduleId": "forge/building/SM_PlankFloor/v1",
    "moduleType": "floor",
    "displayName": "SM_PlankFloor",
    "dimensions": {
      "widthCm": 559.9000244140625,
      "depthCm": 520,
      "heightCm": 10
    },
    "pivot": {
      "kind": "center"
    },
    "sockets": [
      {
        "id": "door",
        "localPosCm": [
          0,
          -270,
          5
        ],
        "accepts": [
          "door"
        ]
      },
      {
        "id": "window",
        "localPosCm": [
          0,
          270,
          95
        ],
        "accepts": [
          "window"
        ]
      }
    ],
    "collision": {
      "profile": "block-all"
    },
    "provenance": {
      "authoredBy": "deterministic"
    },
    "engines": {
      "unreal": [
        "4.27"
      ],
      "blender": [
        "4.5"
      ]
    },
    "sourceAsset": "architecture/SM_PlankFloor.fbx",
    "engineAsset": "/Game/ForgeAAA/R82/SM_PlankFloor",
    "coordinateSystem": "unreal-cm-z-up",
    "materials": [
      "Forge_wood"
    ],
    "dependencies": [],
    "validationStatus": "geometry-verified",
    "contentSha256": "3282c64b5032b778bc29dc0969e6f23f29ef8538782ce539745b70379e2fae91"
  },
  {
    "contractVersion": 1,
    "moduleVersion": 1,
    "moduleId": "forge/building/SM_WindowFrame/v1",
    "moduleType": "window",
    "displayName": "SM_WindowFrame",
    "dimensions": {
      "widthCm": 119.99999237060547,
      "depthCm": 16,
      "heightCm": 140
    },
    "pivot": {
      "kind": "custom",
      "offsetCm": [
        0,
        0,
        0
      ]
    },
    "sockets": [],
    "collision": {
      "profile": "block-all"
    },
    "provenance": {
      "authoredBy": "deterministic"
    },
    "engines": {
      "unreal": [
        "4.27"
      ],
      "blender": [
        "4.5"
      ]
    },
    "sourceAsset": "architecture/SM_WindowFrame.fbx",
    "engineAsset": "/Game/ForgeAAA/R82/SM_WindowFrame",
    "coordinateSystem": "unreal-cm-z-up",
    "materials": [
      "Forge_wood",
      "Forge_glass"
    ],
    "dependencies": [],
    "validationStatus": "geometry-verified",
    "contentSha256": "830a42b07d97ac5bfd1ae4b0cb440aacba84ee1cba7f5106b02a904a7465d6ac",
    "nativeClass": "/Script/ForgeGameplay.ForgeInteractableWindow",
    "leafAsset": "/Game/ForgeAAA/R82/SM_WindowSash",
    "persistence": {
      "identityFrom": "instanceId",
      "stateFields": [
        "state",
        "slideCm"
      ],
      "schemaVersion": 1
    },
    "interaction": {
      "interface": "IForgeInteractable",
      "states": [
        "closed",
        "opening",
        "open",
        "closing"
      ],
      "initialState": "closed"
    }
  },
  {
    "contractVersion": 1,
    "moduleId": "dtw/building/door-western/v1",
    "moduleType": "door",
    "displayName": "Western Farmhouse Door",
    "dimensions": {
      "widthCm": 104,
      "depthCm": 24,
      "heightCm": 214
    },
    "pivot": {
      "kind": "hinge-left"
    },
    "sockets": [
      {
        "id": "frame",
        "localPosCm": [
          0,
          0,
          0
        ],
        "accepts": [
          "wall"
        ]
      }
    ],
    "collision": {
      "profile": "custom",
      "blocksWhenClosed": true,
      "passesWhenOpen": true
    },
    "provenance": {
      "authoredBy": "model",
      "modelId": "nvidia/nemotron-3-super-120b-a12b:free"
    },
    "engines": {
      "unreal": [
        "4.27"
      ],
      "blender": [
        "4.5"
      ]
    },
    "interaction": {
      "interface": "IForgeInteractable",
      "states": [
        "closed",
        "opening",
        "open",
        "closing"
      ],
      "initialState": "closed"
    },
    "persistence": {
      "identityFrom": "instanceId",
      "stateFields": [
        "state",
        "yawAngle"
      ],
      "schemaVersion": 1
    },
    "moduleVersion": 1,
    "sourceAsset": "door.fbx",
    "engineAsset": "/Game/ForgeAAA/door_SM_DoorFrame",
    "leafAsset": "/Game/ForgeAAA/door_SM_DoorLeaf",
    "nativeClass": "/Script/ForgeGameplay.ForgeInteractableDoor",
    "coordinateSystem": "unreal-cm-z-up",
    "materials": [
      "wood"
    ],
    "dependencies": [],
    "validationStatus": "geometry-verified",
    "contentSha256": "0f686865817ea225d396291352d87eca75e28f420c01ecc147c6aead63db7aa8"
  }
];

// R83 additional modules for the connected second room
export const R83_NEW_MODULES: BuildingModuleDefinition[] = [
{
  "contractVersion": 1,
  "moduleVersion": 1,
  "moduleId": "forge/building/SM_DoorThreshold/v1",
  "moduleType": "floor",
  "displayName": "Shared doorway threshold",
  "dimensions": {
    "widthCm": 20,
    "depthCm": 110,
    "heightCm": 10
  },
  "pivot": {
    "kind": "center"
  },
  "sockets": [],
  "collision": {
    "profile": "block-all"
  },
  "provenance": {
    "authoredBy": "deterministic"
  },
  "engines": {
    "unreal": [
      "4.27"
    ],
    "blender": [
      "4.5"
    ]
  },
  "sourceAsset": "architecture/SM_DoorThreshold.fbx",
  "engineAsset": "/Game/ForgeAAA/R83/SM_DoorThreshold",
  "coordinateSystem": "unreal-cm-z-up",
  "materials": [
    "Forge_wood"
  ],
  "dependencies": [],
  "validationStatus": "geometry-verified"
},
  {
    contractVersion: 1,
    moduleVersion: 1,
    moduleId: "forge/building/SM_SharedWall_Front/v1",
    moduleType: "wall",
    displayName: "SM_SharedWall_Front",
    dimensions: { widthCm: 20, depthCm: 225, heightCm: 260 },
    pivot: { kind: "center" },
    sockets: [{ id: "door-int", localPosCm: [0, 167.5, -130], accepts: ["door"] }],
    collision: { profile: "block-all" },
    provenance: { authoredBy: "deterministic" },
    engines: { unreal: ["4.27"] },
    sourceAsset: "architecture/SM_SharedWall_Front.fbx",
    engineAsset: "/Game/ForgeAAA/R83/SM_SharedWall_Front",
    coordinateSystem: "unreal-cm-z-up",
    materials: ["Forge_plaster"],
    dependencies: [],
    validationStatus: "geometry-verified",
  },
  {
    contractVersion: 1,
    moduleVersion: 1,
    moduleId: "forge/building/SM_SharedWall_Back/v1",
    moduleType: "wall",
    displayName: "SM_SharedWall_Back",
    dimensions: { widthCm: 20, depthCm: 225, heightCm: 260 },
    pivot: { kind: "center" },
    sockets: [],
    collision: { profile: "block-all" },
    provenance: { authoredBy: "deterministic" },
    engines: { unreal: ["4.27"] },
    sourceAsset: "architecture/SM_SharedWall_Back.fbx",
    engineAsset: "/Game/ForgeAAA/R83/SM_SharedWall_Back",
    coordinateSystem: "unreal-cm-z-up",
    materials: ["Forge_plaster"],
    dependencies: [],
    validationStatus: "geometry-verified",
  },
  {
    contractVersion: 1,
    moduleVersion: 1,
    moduleId: "forge/building/SM_SharedWall_Lintel/v1",
    moduleType: "wall",
    displayName: "SM_SharedWall_Lintel",
    dimensions: { widthCm: 20, depthCm: 110, heightCm: 45 },
    pivot: { kind: "center" },
    sockets: [],
    collision: { profile: "block-all" },
    provenance: { authoredBy: "deterministic" },
    engines: { unreal: ["4.27"] },
    sourceAsset: "architecture/SM_SharedWall_Lintel.fbx",
    engineAsset: "/Game/ForgeAAA/R83/SM_SharedWall_Lintel",
    coordinateSystem: "unreal-cm-z-up",
    materials: ["Forge_plaster"],
    dependencies: [],
    validationStatus: "geometry-verified",
  },
  {
    contractVersion: 1,
    moduleVersion: 1,
    moduleId: "forge/building/SM_FrontWall_B/v1",
    moduleType: "wall",
    displayName: "SM_FrontWall_B",
    dimensions: { widthCm: 560, depthCm: 20, heightCm: 260 },
    pivot: { kind: "center" },
    sockets: [],
    collision: { profile: "block-all" },
    provenance: { authoredBy: "deterministic" },
    engines: { unreal: ["4.27"] },
    sourceAsset: "architecture/SM_FrontWall_B.fbx",
    engineAsset: "/Game/ForgeAAA/R83/SM_FrontWall_B",
    coordinateSystem: "unreal-cm-z-up",
    materials: ["Forge_plaster"],
    dependencies: [],
    validationStatus: "geometry-verified",
  },
  {
    contractVersion: 1,
    moduleVersion: 1,
    moduleId: "forge/building/SM_Ceiling_B/v1",
    moduleType: "roof",
    displayName: "SM_Ceiling_B",
    dimensions: { widthCm: 580, depthCm: 560, heightCm: 10 },
    pivot: { kind: "center" },
    sockets: [],
    collision: { profile: "block-all" },
    provenance: { authoredBy: "deterministic" },
    engines: { unreal: ["4.27"] },
    sourceAsset: "architecture/SM_Ceiling_B.fbx",
    engineAsset: "/Game/ForgeAAA/R83/SM_Ceiling_B",
    coordinateSystem: "unreal-cm-z-up",
    materials: ["Forge_wood"],
    dependencies: [],
    validationStatus: "geometry-verified",
  },
];

export const R83_TWO_ROOM_MODULES: BuildingModuleDefinition[] = [
  ...R82_ONE_ROOM_MODULES,
  ...R83_NEW_MODULES,
];

// R82 single room building definition (14 instances)
export const R82_ONE_ROOM_BUILDING: BuildingDefinition = {
  schemaVersion: 1,
  buildingInstanceId: "western-room-a",
  attachmentToleranceCm: 0.5,
  instances: [
    { instanceId: "floor", moduleId: "forge/building/SM_PlankFloor/v1", moduleVersion: 1, positionCm: [0, 260, -5], yawDeg: 0 },
    { instanceId: "front-left", moduleId: "forge/building/SM_FrontWall/v1", moduleVersion: 1, positionCm: [-167.5, -10, 130], yawDeg: 0 },
    { instanceId: "front-right", moduleId: "forge/building/SM_FrontWall/v1", moduleVersion: 1, positionCm: [167.5, -10, 130], yawDeg: 0 },
    { instanceId: "door-lintel", moduleId: "forge/building/SM_DoorLintel/v1", moduleVersion: 1, positionCm: [0, -10, 237.5], yawDeg: 0 },
    { instanceId: "wall-left", moduleId: "forge/building/SM_SideWall/v1", moduleVersion: 1, positionCm: [-290, 260, 130], yawDeg: 0 },
    { instanceId: "wall-right", moduleId: "forge/building/SM_SideWall/v1", moduleVersion: 1, positionCm: [290, 260, 130], yawDeg: 0 },
    { instanceId: "back-left", moduleId: "forge/building/SM_BackWall/v1", moduleVersion: 1, positionCm: [-170, 530, 130], yawDeg: 0 },
    { instanceId: "back-right", moduleId: "forge/building/SM_BackWall/v1", moduleVersion: 1, positionCm: [170, 530, 130], yawDeg: 0 },
    { instanceId: "sill", moduleId: "forge/building/SM_WindowSillWall/v1", moduleVersion: 1, positionCm: [0, 530, 45], yawDeg: 0 },
    { instanceId: "window-header", moduleId: "forge/building/SM_WindowHeader/v1", moduleVersion: 1, positionCm: [0, 530, 245], yawDeg: 0 },
    { instanceId: "ceiling", moduleId: "forge/building/SM_Ceiling/v1", moduleVersion: 1, positionCm: [0, 260, 265], yawDeg: 0 },
    { instanceId: "entrance-floor", moduleId: "forge/building/SM_ExteriorFloor/v1", moduleVersion: 1, positionCm: [0, -120, -5], yawDeg: 0 },
    { instanceId: "door", moduleId: "dtw/building/door-western/v1", moduleVersion: 1, positionCm: [0, -10, 0], yawDeg: 0, attachment: { instanceId: "floor", socketId: "door" } },
    { instanceId: "window", moduleId: "forge/building/SM_WindowFrame/v1", moduleVersion: 1, positionCm: [0, 530, 90], yawDeg: 0, attachment: { instanceId: "floor", socketId: "window" } },
  ],
};

// The east wall becomes an explicit traversable connection; original actor identities remain.
export const R83_TWO_ROOM_BUILDING: ConnectedBuildingDefinition = {
  schemaVersion: 1,
  revision: 2,
  migration: { sourceRevision: 1, preservedInstanceIds: R82_ONE_ROOM_BUILDING.instances.filter(i => i.instanceId !== "wall-right").map(i => i.instanceId), removedInstanceIds: ["wall-right"] },
  rooms: [
    { roomId: "living-room", purpose: "living", floorInstanceId: "floor", ceilingInstanceId: "ceiling", centerCm: [0,260,0], interiorCm: [560,520,260], instanceIds: R82_ONE_ROOM_BUILDING.instances.filter(i => i.instanceId !== "wall-right").map(i => i.instanceId) },
    { roomId: "workroom", purpose: "workroom", floorInstanceId: "floor-b", ceilingInstanceId: "ceiling-b", centerCm: [580,260,0], interiorCm: [560,520,260], instanceIds: ["floor-b","front-b","back-b","wall-right-b","ceiling-b","door-interior"] },
  ],
  connections: [{ connectionId: "living-workroom", rooms: ["living-room","workroom"], walls: ["east","west"], normalAxis: "x", centerCm: [290,260,0], openingWidthCm: 110, openingHeightCm: 215, wallThicknessCm: 20, doorInstanceId: "door-interior", thresholdInstanceId: "threshold", wallInstanceIds: ["shared-wall-front","shared-wall-back","shared-wall-lintel"], supersededInstanceId: "wall-right", swingClearanceCm: 110 }],
  buildingInstanceId: "western-room-a",
  attachmentToleranceCm: 0.5,
  instances: [
    { instanceId: "floor", moduleId: "forge/building/SM_PlankFloor/v1", moduleVersion: 1, positionCm: [0, 260, -5], yawDeg: 0 },
    { instanceId: "front-left", moduleId: "forge/building/SM_FrontWall/v1", moduleVersion: 1, positionCm: [-167.5, -10, 130], yawDeg: 0 },
    { instanceId: "front-right", moduleId: "forge/building/SM_FrontWall/v1", moduleVersion: 1, positionCm: [167.5, -10, 130], yawDeg: 0 },
    { instanceId: "door-lintel", moduleId: "forge/building/SM_DoorLintel/v1", moduleVersion: 1, positionCm: [0, -10, 237.5], yawDeg: 0 },
    { instanceId: "wall-left", moduleId: "forge/building/SM_SideWall/v1", moduleVersion: 1, positionCm: [-290, 260, 130], yawDeg: 0 },
    { instanceId: "back-left", moduleId: "forge/building/SM_BackWall/v1", moduleVersion: 1, positionCm: [-170, 530, 130], yawDeg: 0 },
    { instanceId: "back-right", moduleId: "forge/building/SM_BackWall/v1", moduleVersion: 1, positionCm: [170, 530, 130], yawDeg: 0 },
    { instanceId: "sill", moduleId: "forge/building/SM_WindowSillWall/v1", moduleVersion: 1, positionCm: [0, 530, 45], yawDeg: 0 },
    { instanceId: "window-header", moduleId: "forge/building/SM_WindowHeader/v1", moduleVersion: 1, positionCm: [0, 530, 245], yawDeg: 0 },
    { instanceId: "ceiling", moduleId: "forge/building/SM_Ceiling/v1", moduleVersion: 1, positionCm: [0, 260, 265], yawDeg: 0 },
    { instanceId: "entrance-floor", moduleId: "forge/building/SM_ExteriorFloor/v1", moduleVersion: 1, positionCm: [0, -120, -5], yawDeg: 0 },
    { instanceId: "door", moduleId: "dtw/building/door-western/v1", moduleVersion: 1, positionCm: [0, -10, 0], yawDeg: 0, attachment: { instanceId: "floor", socketId: "door" } },
    { instanceId: "window", moduleId: "forge/building/SM_WindowFrame/v1", moduleVersion: 1, positionCm: [0, 530, 90], yawDeg: 0, attachment: { instanceId: "floor", socketId: "window" } },

    { instanceId: "shared-wall-front", moduleId: "forge/building/SM_SharedWall_Front/v1", moduleVersion: 1, positionCm: [290, 92.5, 130], yawDeg: 0 },
    { instanceId: "shared-wall-lintel", moduleId: "forge/building/SM_SharedWall_Lintel/v1", moduleVersion: 1, positionCm: [290, 260, 237.5], yawDeg: 0 },
    { instanceId: "shared-wall-back", moduleId: "forge/building/SM_SharedWall_Back/v1", moduleVersion: 1, positionCm: [290, 427.5, 130], yawDeg: 0 },

    { instanceId: "floor-b", moduleId: "forge/building/SM_PlankFloor/v1", moduleVersion: 1, positionCm: [580, 260, -5], yawDeg: 0 },
    { instanceId: "front-b", moduleId: "forge/building/SM_FrontWall_B/v1", moduleVersion: 1, positionCm: [580, -10, 130], yawDeg: 0 },
    { instanceId: "back-b", moduleId: "forge/building/SM_FrontWall_B/v1", moduleVersion: 1, positionCm: [580, 530, 130], yawDeg: 0 },
    { instanceId: "wall-right-b", moduleId: "forge/building/SM_SideWall/v1", moduleVersion: 1, positionCm: [870, 260, 130], yawDeg: 0 },
    { instanceId: "ceiling-b", moduleId: "forge/building/SM_Ceiling_B/v1", moduleVersion: 1, positionCm: [590, 260, 265], yawDeg: 0 },

    { instanceId: "threshold", moduleId: "forge/building/SM_DoorThreshold/v1", moduleVersion: 1, positionCm: [290, 260, -5], yawDeg: 0 },

    { instanceId: "door-interior", moduleId: "dtw/building/door-western/v1", moduleVersion: 1, positionCm: [290, 260, 0], yawDeg: 90, attachment: { instanceId: "shared-wall-front", socketId: "door-int" } },
  ],
};
