declare module "@cubone/react-file-manager" {
  import type { ComponentType, ReactNode } from "react";
  export interface FileManagerEntry { name: string; path: string; isDirectory: boolean; updatedAt?: string; size?: number }
  export interface FileManagerProps {
    files: FileManagerEntry[];
    initialPath?: string;
    layout?: "list" | "grid";
    height?: string | number;
    width?: string | number;
    fontFamily?: string;
    primaryColor?: string;
    language?: string;
    isLoading?: boolean;
    collapsibleNav?: boolean;
    enableFilePreview?: boolean;
    permissions?: Partial<Record<"create" | "upload" | "move" | "copy" | "rename" | "download" | "delete", boolean>>;
    onCreateFolder?: (name: string, parent: FileManagerEntry | null) => void;
    onRename?: (file: FileManagerEntry, name: string) => void;
    onDelete?: (files: FileManagerEntry[]) => void;
    onPaste?: (files: FileManagerEntry[], destination: FileManagerEntry | null, operation: "copy" | "move") => void;
    onDownload?: (files: FileManagerEntry[]) => void;
    onRefresh?: () => void;
    onFolderChange?: (path: string) => void;
    onFileOpen?: (file: FileManagerEntry) => void;
    onError?: (error: { type: string; message: string }, file: FileManagerEntry) => void;
    filePreviewComponent?: (file: FileManagerEntry) => ReactNode;
  }
  export const FileManager: ComponentType<FileManagerProps>;
}
