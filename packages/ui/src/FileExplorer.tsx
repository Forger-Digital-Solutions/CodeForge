import React, { useState, useEffect, useCallback } from "react";

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  expanded?: boolean;
}

interface FileExplorerProps {
  rootPath: string;
  onFileSelect?: (path: string) => void;
  refreshKey?: number;
}

export default function FileExplorer({ rootPath, onFileSelect, refreshKey }: FileExplorerProps) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTree = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspace/tree?path=${encodeURIComponent(rootPath)}`);
      if (!response.ok) {
        throw new Error("Failed to load file tree");
      }
      const data = await response.json();
      setTree(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree, refreshKey]);

  const handleToggle = (path: string) => {
    const toggleNode = (nodes: FileNode[]): FileNode[] => {
      return nodes.map((node) => {
        if (node.path === path) {
          return { ...node, expanded: !node.expanded };
        }
        if (node.children) {
          return { ...node, children: toggleNode(node.children) };
        }
        return node;
      });
    };
    setTree(toggleNode(tree));
  };

  const handleClick = (node: FileNode) => {
    if (node.type === "directory") {
      handleToggle(node.path);
    } else if (onFileSelect) {
      onFileSelect(node.path);
    }
  };

  const renderNode = (node: FileNode, depth: number = 0) => {
    const indent = depth * 16;
    const icon = node.type === "directory" 
      ? (node.expanded ? "📂" : "📁") 
      : getFileIcon(node.name);
    
    return (
      <div key={node.path} className="file-node">
        <button
          className={`file-item ${node.type}`}
          style={{ paddingLeft: indent + 8 }}
          onClick={() => handleClick(node)}
        >
          <span className="file-icon">{icon}</span>
          <span className="file-name">{node.name}</span>
        </button>
        {node.type === "directory" && node.expanded && node.children && (
          <div className="file-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return <div className="file-explorer-loading">Loading files...</div>;
  }

  if (error) {
    return (
      <div className="file-explorer-error">
        <span>{error}</span>
        <button onClick={fetchTree}>Retry</button>
      </div>
    );
  }

  if (tree.length === 0) {
    return <div className="file-explorer-empty">No files</div>;
  }

  return (
    <div className="file-explorer">
      <div className="file-explorer-header">
        <span className="explorer-title">Files</span>
        <button className="explorer-refresh" onClick={fetchTree} title="Refresh">
          🔄
        </button>
      </div>
      <div className="file-explorer-tree">
        {tree.map((node) => renderNode(node))}
      </div>
    </div>
  );
}

function getFileIcon(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const icons: Record<string, string> = {
    ts: "📄",
    tsx: "📄",
    js: "📄",
    jsx: "📄",
    json: "⚙",
    md: "📝",
    css: "🎨",
    html: "🌐",
    svg: "🖼",
    png: "🖼",
    jpg: "🖼",
    git: "📦",
    env: "🔒",
    yaml: "⚙",
    yml: "⚙",
    lock: "🔒",
  };
  return icons[ext || ""] || "📄";
}
