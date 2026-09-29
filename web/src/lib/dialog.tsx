/* 对话框：任何地方调用 openDialog(关闭 => 内容) 打开；同一时间只有一个 */
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { create } from "zustand";
import { cx } from "./cx";

type Render = (close: () => void) => ReactNode;
export const useDialog = create<{ render: Render | null; key: number }>(() => ({ render: null, key: 0 }));
export const openDialog = (render: Render) => useDialog.setState((s) => ({ render, key: s.key + 1 }));
export const closeDialog = () => useDialog.setState({ render: null });

export function DialogHost() {
  const { render, key } = useDialog();
  if (!render) return null;
  return <div key={key}>{render(closeDialog)}</div>;
}

/** 对话框外壳：标题、说明、内容、底部按钮 */
export function Dialog({
  title,
  desc,
  children,
  footer,
  wide,
  onClose,
  dismissable = true,
}: {
  title: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  onClose: () => void;
  dismissable?: boolean;
}) {
  return (
    <D.Root open onOpenChange={(o) => !o && dismissable && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-[rgb(15_18_22/0.38)] backdrop-blur-[2px]" />
        <D.Content
          onEscapeKeyDown={(e) => !dismissable && e.preventDefault()}
          onPointerDownOutside={(e) => !dismissable && e.preventDefault()}
          className={cx(
            "fixed top-1/2 left-1/2 z-40 flex max-h-[min(88vh,900px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[18px] border border-line bg-surface shadow-3 outline-none",
            wide ? "max-w-[860px]" : "max-w-[560px]",
          )}
        >
          <div className="flex items-start gap-3 px-6 pt-5 pb-2">
            <div className="min-w-0 grow">
              <D.Title className="text-[17px] font-bold text-fg">{title}</D.Title>
              {desc ? <D.Description className="mt-1 text-[13px] leading-relaxed text-muted">{desc}</D.Description> : <D.Description className="sr-only">{String(title)}</D.Description>}
            </div>
            {dismissable && (
              <D.Close aria-label="关闭" className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-4">
                <X />
              </D.Close>
            )}
          </div>
          <div className="scroll-quiet flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-3">{children}</div>
          {footer && <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-6 py-3.5">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
