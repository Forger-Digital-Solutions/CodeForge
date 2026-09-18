const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("codeforgeDiagnostic", Object.freeze({ probe: "secure-minimal" }));
