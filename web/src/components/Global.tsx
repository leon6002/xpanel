/* 全局的小部件：连接横幅、选中文字浮出「问 AI」、任何地方粘贴截图 / 拖入文件、快捷键 */
import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errText, isApp } from "../lib/api";
import { qc, useAppState, useConfig, useThisDevice } from "../lib/data";
import { useDrafts } from "../lib/drafts";
import { clipFiles } from "../lib/logic";
import { selectionContext, type QaSel } from "../lib/qa";
import { useUi } from "../lib/store";
import { TYPES } from "../lib/types";
import { openAsk } from "../dialogs/Ask";
import { openDevices } from "../dialogs/Devices";
import { openSettings } from "../dialogs/Settings";
import { importWechat } from "./Inbox";
import { Button } from "./ui";

/** 连不上数据、离线时顶部的提示 */
export function Banner() {
  const { data, error } = useAppState();
  if (error)
    return (
      <div className="flex items-center gap-3 rounded-xl bg-danger-soft px-4 py-2.5 text-[13px] text-danger">
        <span className="grow">
          <b>连不上数据</b>　{errText(error)}
        </span>
        <Button onClick={() => qc.invalidateQueries()}>重试</Button>
        {isApp && <Button onClick={() => openSettings()}>设置</Button>}
      </div>
    );
  if (data?.offline)
    return (
      <div className="flex items-center gap-3 rounded-xl bg-warn-soft px-4 py-2.5 text-[13px] text-warn-fg">
        <span className="grow">
          <b>离线模式</b>　连不上主机，正在显示上次的数据。
          {data.pending ? `刚才的 ${data.pending} 条改动存在本机，恢复连接后会自动上传。` : "可以照常记录，恢复连接后会自动上传。"}
        </span>
        <Button onClick={() => qc.invalidateQueries()}>重试</Button>
      </div>
    );
  return null;
}

/** 在阅读区选中一段文字 → 浮出「问 AI」 */
export function QaFloat() {
  const [pos, setPos] = useState<{ x: number; y: number; sel: QaSel } | null>(null);
  useEffect(() => {
    const up = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.(".qa-float")) return;
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return setPos(null);
        const r = sel.getRangeAt(0);
        const node = r.commonAncestorContainer;
        const host = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest("[data-qa-host]") as HTMLElement | null;
        if (!host) return setPos(null);
        const ctx = selectionContext(host, r, host.dataset.qaHost!);
        if (!ctx) return setPos(null);
        const rect = r.getBoundingClientRect();
        setPos({ x: Math.min(window.innerWidth - 110, rect.right - 40), y: rect.bottom + 6, sel: ctx });
      }, 0);
    };
    const down = (e: MouseEvent) => !(e.target as HTMLElement).closest?.(".qa-float") && setPos(null);
    document.addEventListener("mouseup", up);
    document.addEventListener("mousedown", down);
    window.addEventListener("scroll", () => setPos(null), true);
    return () => {
      document.removeEventListener("mouseup", up);
      document.removeEventListener("mousedown", down);
    };
  }, []);
  if (!pos) return null;
  return (
    <button
      className="qa-float fixed z-30 inline-flex h-8 items-center gap-1.5 rounded-full bg-fg px-3 text-[12.5px] font-semibold text-bg shadow-3 [&_svg]:size-3.5"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const s = pos.sel;
        setPos(null);
        openAsk(s);
      }}
    >
      <Sparkles />问 AI
    </button>
  );
}

/** 粘贴截图 / 拖入文件：编辑框里插到光标处（编辑框自己处理），其他地方放进快速记录（收件箱页放进输入框）；微信导出的 ZIP 走导入 */
export function useGlobalInput() {
  const [drop, setDrop] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const box = () => (useUi.getState().view === "inbox" ? "inbox" : "capture");
    // 快速记录收起时先展开（它自己会把光标放进去）
    const focusBox = () => (box() === "inbox" ? document.getElementById("xp-inbox-input")?.focus() : useUi.getState().focusCapture());
    const inEditor = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("[data-editor]");
    const paste = (e: ClipboardEvent) => {
      if (inEditor(e.target)) return;
      const files = clipFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      const b = box();
      if (b === "inbox") useUi.getState().setIbx("me");
      files.forEach((f) => useDrafts.getState().addFile(b, f));
      if (e.target !== document.getElementById(b === "inbox" ? "xp-inbox-input" : "xp-capture")) {
        focusBox();
        useUi.getState().say(b === "inbox" ? "截图已放进输入框，回车发送" : "截图已放进「快速记录」，回车保存");
      }
    };
    const over = (e: DragEvent) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
      e.preventDefault();
      if (!inEditor(e.target)) setDrop(true);
    };
    const enter = () => depth.current++;
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDrop(false);
    };
    const dropped = async (e: DragEvent) => {
      depth.current = 0;
      setDrop(false);
      if (inEditor(e.target)) return;
      const files = clipFiles(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) {
        if (/\.zip$/i.test(f.name || "") && (await importWechat(f))) continue;
        const b = box();
        if (b === "inbox") useUi.getState().setIbx("me");
        useDrafts.getState().addFile(b, f);
      }
      focusBox();
    };
    document.addEventListener("paste", paste);
    document.addEventListener("dragover", over);
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", dropped);
    return () => {
      document.removeEventListener("paste", paste);
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", dropped);
    };
  }, []);

  // 快捷键：/ 聚焦输入；Alt+1…6 切换快速记录的类型
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      const typing = !!a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable);
      if (e.key === "/" && !typing && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        useUi.getState().focusCapture();
      }
      if (e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        useUi.getState().setCapType(TYPES[+e.key - 1].k);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return drop;
}

/** 桌面版还没选「这台电脑是哪台设备」：打开设备页提示一次 */
export function useClaimPrompt() {
  const cfg = useConfig().data;
  const me = useThisDevice();
  const st = useAppState();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !isApp || !cfg?.config.mode || !st.isSuccess) return;
    done.current = true;
    if (!me.id) openDevices();
  }, [cfg, me.id, st.isSuccess]);
}
