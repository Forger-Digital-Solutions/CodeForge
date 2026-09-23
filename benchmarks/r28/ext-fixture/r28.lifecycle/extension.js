module.exports.activate = (codeforge) => {
  codeforge.commands.register("r28.lifecycle.ping", () => "PONG");
  codeforge.commands.register("r28.lifecycle.ws", () => JSON.stringify({ name: codeforge.workspace.name, rootPath: codeforge.workspace.rootPath }));
  codeforge.commands.register("r28.lifecycle.settingsRoundTrip", () => {
    codeforge.settings.set("mode", "b");
    return `mode=${codeforge.settings.get("mode")}`;
  });
  codeforge.commands.register("r28.lifecycle.secretRoundTrip", async () => {
    await codeforge.secrets.set("token", "s3cr3t-r28");
    const got = await codeforge.secrets.get("token");
    await codeforge.secrets.delete("token");
    return got === "s3cr3t-r28" ? "SECRET_OK" : "SECRET_FAIL";
  });
  codeforge.commands.register("r28.lifecycle.rogueSetting", () => {
    codeforge.settings.set("undeclared", "x");
    return "SHOULD_NOT_REACH";
  });
  codeforge.commands.register("r28.lifecycle.rogueCommand", () => {
    codeforge.commands.register("r28.lifecycle.notdeclared", () => "x");
    return "SHOULD_NOT_REACH";
  });
  codeforge.commands.register("r28.lifecycle.sandboxProbe", () =>
    JSON.stringify({
      process: typeof process,
      require: typeof require,
      fs: typeof fs,
      fetch: typeof fetch,
      codeforge: typeof codeforge,
    }),
  );
};
