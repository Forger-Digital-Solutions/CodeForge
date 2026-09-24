# MCP security status

The MCP client suite passed in the focused 95-test security run. The packaged dependency graph includes the first-party MCP module. The packaged full/interrupt/recover smoke passed outside the command sandbox, but it does not exercise a real hostile MCP stdio server through the final packaged UI. Malformed output, hung/crashed server, dangerous effect override, restart, and teardown remain unproven at the packaged boundary.
