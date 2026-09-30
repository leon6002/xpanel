// 块编辑器 Markdown 往返测试：window.rt(md) → 解析成文档再写回 Markdown
import { Editor } from "@tiptap/core";
import { editorExtensions, tidyMarkdown, useGentleMarkdown } from "../src/lib/editor";
const ed = new Editor({ element: document.getElementById("ed")!, extensions: editorExtensions() });
useGentleMarkdown(ed);
(window as unknown as { rt: (md: string) => string }).rt = (md: string) => {
  ed.commands.setContent(md, { contentType: "markdown" });
  return tidyMarkdown(ed.getMarkdown());
};
(window as unknown as { ready: boolean }).ready = true;
