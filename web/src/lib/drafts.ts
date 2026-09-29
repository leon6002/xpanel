/* 快速记录和收件箱输入框的草稿：文字 + 待发送的截图 / 附件。
   截图一粘贴就先上传，发送时只写引用；草稿存在本机，刷新或关掉窗口也不丢（和旧界面用同一个存储键）。 */
import { create } from "zustand";
import { errText, putAsset } from "./api";
import { fileLabel, isImgFile } from "./logic";
import { ls } from "./store";
import { useUi } from "./store";

export type Box = "capture" | "inbox";
export interface PFile { id: string; label: string; isImg: boolean; url: string; uploading: boolean; name: string | null }
interface Draft { text: string; files: PFile[] }
const KEY: Record<Box, string> = { capture: "wb-capdraft", inbox: "wb-ibxdraft" };
const rid = () => Math.random().toString(36).slice(2);

function load(b: Box): Draft {
  try {
    const d = JSON.parse(ls.get(KEY[b]) || "null") as { text?: string; files?: { name: string; label: string; isImg: boolean }[] } | null;
    if (!d) return { text: "", files: [] };
    return { text: d.text || "", files: (d.files || []).map((f) => ({ ...f, id: rid(), url: "", uploading: false })) };
  } catch {
    return { text: "", files: [] };
  }
}
function save(b: Box, d: Draft) {
  const files = d.files.filter((f) => f.name).map(({ name, label, isImg }) => ({ name, label, isImg }));
  ls.set(KEY[b], d.text || files.length ? JSON.stringify({ text: d.text, files }) : null);
}

interface Drafts {
  capture: Draft;
  inbox: Draft;
  setText: (b: Box, text: string) => void;
  addFile: (b: Box, file: File) => void;
  removeFile: (b: Box, id: string) => void;
  clear: (b: Box) => void;
  restore: (b: Box, d: Draft) => void;
}

export const useDrafts = create<Drafts>((set, get) => {
  const put = (b: Box, d: Draft) => {
    set({ [b]: d } as Pick<Drafts, Box>);
    save(b, d);
  };
  return {
    capture: load("capture"),
    inbox: load("inbox"),
    setText: (b, text) => put(b, { ...get()[b], text }),
    addFile: (b, file) => {
      const f: PFile = { id: rid(), label: fileLabel(file), isImg: isImgFile(file), url: isImgFile(file) ? URL.createObjectURL(file) : "", uploading: true, name: null };
      put(b, { ...get()[b], files: [...get()[b].files, f] });
      putAsset(file).then(
        (name) => put(b, { ...get()[b], files: get()[b].files.map((x) => (x.id === f.id ? { ...x, name, uploading: false } : x)) }),
        (e) => {
          put(b, { ...get()[b], files: get()[b].files.filter((x) => x.id !== f.id) });
          useUi.getState().say("保存失败：" + errText(e));
        },
      );
    },
    removeFile: (b, id) => put(b, { ...get()[b], files: get()[b].files.filter((x) => x.id !== id) }),
    clear: (b) => put(b, { text: "", files: [] }),
    restore: (b, d) => put(b, d),
  };
});
