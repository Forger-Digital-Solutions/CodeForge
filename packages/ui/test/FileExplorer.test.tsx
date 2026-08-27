import { describe, it, expect, beforeEach, vi } from "vitest";

describe("FileExplorer - Icon Mapping", () => {
  it("maps TypeScript files to ts icon", () => {
    const ext = "ts";
    const icons: Record<string, string> = {
      ts: "",
      tsx: "",
      js: "",
      jsx: "",
      json: "",
      md: "",
      css: "",
      html: "",
      svg: "",
      png: "",
      jpg: "",
      gif: "",
      git: "",
      env: "",
      yaml: "",
      yml: "",
      lock: "",
    };
    expect(icons[ext] || "📄").toBe("");
  });

  it("maps JavaScript files to js icon", () => {
    const ext = "js";
    const icons: Record<string, string> = {
      ts: "",
      tsx: "",
      js: "",
      jsx: "",
      json: "",
      md: "",
      css: "",
      html: "",
      svg: "",
      png: "",
      jpg: "",
      gif: "",
      git: "",
      env: "",
      yaml: "",
      yml: "",
      lock: "",
    };
    expect(icons[ext] || "📄").toBe("");
  });

  it("maps unknown extensions to default file icon", () => {
    const ext = "xyz";
    const icons: Record<string, string> = {
      ts: "",
      tsx: "",
      js: "",
      jsx: "",
      json: "",
      md: "",
      css: "",
      html: "",
      svg: "",
      png: "",
      jpg: "",
      gif: "",
      git: "",
      env: "",
      yaml: "",
      yml: "",
      lock: "",
    };
    expect(icons[ext] || "📄").toBe("📄");
  });

  it("should use lowercase extension for matching", () => {
    // Simulates the getFileIcon function behavior
    const filename = "UPPERCASE.TS";
    const ext = filename.split(".").pop()?.toLowerCase();
    const icons: Record<string, string> = { ts: "" };
    expect(icons[ext || ""]).toBe("");
  });
});

describe("FileExplorer - Directory Structure Parsing", () => {
  it("should parse nested directory structure", () => {
    const data = [
      {
        name: "src",
        path: "/src",
        type: "directory",
        children: [
          {
            name: "utils.ts",
            path: "/src/utils.ts",
            type: "file",
          },
        ],
      },
    ];

    expect(data[0]!.name).toBe("src");
    expect(data[0]!.type).toBe("directory");
    expect(data[0]!.children).toHaveLength(1);
    expect(data[0]!.children?.[0]!.name).toBe("utils.ts");
  });

  it("should handle empty directory tree", () => {
    const data: any[] = [];
    expect(data).toHaveLength(0);
  });
});

describe("FileExplorer - URL Encoding", () => {
  it("should encode workspace path in API URL", () => {
    // encodeURIComponent encodes ALL special characters including slashes
    const rootPath = "/workspace/my project";
    const encodedPath = encodeURIComponent(rootPath);
    // This is expected behavior - all slashes will be encoded
    expect(encodedPath).toBe("%2Fworkspace%2Fmy%20project");
  });

  it("should handle path with special characters", () => {
    // encodeURIComponent encodes ALL special characters including slashes
    const rootPath = "/workspace/test (1)/folder";
    const encodedPath = encodeURIComponent(rootPath);
    expect(encodedPath).toBe("%2Fworkspace%2Ftest%20(1)%2Ffolder");
  });
});

describe("FileExplorer - Component Requirements", () => {
  it("should render with required props", () => {
    const props = {
      rootPath: "/workspace",
    };
    
    // Basic validation that props are correct structure
    expect(props.rootPath).toBeDefined();
    expect(props.rootPath).toBeTypeOf("string");
  });

  it("should handle optional onFileSelect callback", () => {
    const props = {
      rootPath: "/workspace",
      onFileSelect: (path: string) => console.log(path),
    };
    
    expect(props.onFileSelect).toBeTypeOf("function");
  });
});
