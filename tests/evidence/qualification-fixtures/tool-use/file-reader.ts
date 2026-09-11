// qualification-fixtures/tool-use/file-reader.ts
// Simple file reader tool for tool calling test

export interface FileReadResult {
  content: string;
  path: string;
  size: number;
}

export interface FileReaderTool {
  readFile(path: string): Promise<FileReadResult>;
}

export function createFileReader(basePath: string): FileReaderTool {
  return {
    async readFile(path: string): Promise<FileReadResult> {
      const fullPath = `${basePath}/${path}`;
      // In real implementation, this would read from filesystem
      // For testing, we return mock data based on path
      const mockFiles: Record<string, string> = {
        "config.json": JSON.stringify({ version: "1.0", debug: true }),
        "data.txt": "Hello, World!\nThis is test data.",
        "empty.txt": "",
      };
      
      const content = mockFiles[path] ?? "";
      return {
        content,
        path,
        size: content.length,
      };
    },
  };
}