import { createServer } from "../packages/server/dist/index.js";

const server = createServer({ port: 3210 });
await server.start();
console.log("CodeForge server running at http://localhost:3210");
