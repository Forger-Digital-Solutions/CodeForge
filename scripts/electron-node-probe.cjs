console.log("electron_node=" + process.versions.node);
try {
  const s = require("node:sqlite");
  console.log("node_sqlite_OK DatabaseSync=" + typeof s.DatabaseSync);
} catch (e) {
  console.log("node_sqlite_FAILED " + e.message);
}
