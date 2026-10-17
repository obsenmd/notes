import type { FileView } from "./file-views";
import type { View } from "./workspace";

// Keep the class identity without a runtime workspace -> FileView -> workspace
// cycle. FileView registers its constructor when its module has initialized.
let fileViewType: (abstract new (...args: any[]) => FileView) | undefined;
export function registerFileViewType(type: abstract new (...args: any[]) => FileView): void { fileViewType = type; }
export function isFileView(view: View): view is FileView { return !!fileViewType && view instanceof fileViewType; }
