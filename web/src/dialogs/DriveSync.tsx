/* 外置硬盘同步：整份数据（数据库 + 附件）和外置硬盘上的文件夹同步，带去出差的电脑上用。
   谁在上次同步后改过就用谁的；两边都改过时让用户选，被覆盖的一边先备份。 */
import { ArrowLeft, ArrowRight, HardDrive, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { desk, errText } from "../lib/api";
import { qc, useConfig } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { ago } from "../lib/logic";
import { useUi } from "../lib/store";
import type { SyncPlan, SyncSide } from "../lib/types";
import { cx } from "../lib/cx";
import { Button, ErrorText, inputCls } from "../components/ui";

const say = (t: string) => useUi.getState().say(t);
const guess = () => (/Mac/i.test(navigator.platform) ? "/Volumes/外置硬盘/xpanel" : "F:\\xpanel");

export function openDriveSync() {
  openDialog((close) => (
    <Dialog wide title="外置硬盘同步" desc="把整份数据（笔记、事项、评论、图片和附件）和外置硬盘上的文件夹同步，插到别的电脑上接着用。" onClose={close}>
      <DriveSync />
    </Dialog>
  ));
}

function Side({ title, s }: { title: string; s: SyncSide }) {
  return (
    <div className="flex flex-1 flex-col gap-1 rounded-xl bg-surface-2 px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
        {title}
        {s.exists && s.changed && <span className="rounded-md bg-accent-soft px-1.5 text-[11px] font-normal text-accent-strong">上次同步后改过</span>}
      </div>
      {s.exists ? (
        <div className="text-[13px] text-muted">
          {s.items} 条 · {s.assets} 个附件
          <br />
          最近修改 {s.last_change ? ago(s.last_change) : "—"}
        </div>
      ) : (
        <div className="text-[13px] text-faint">还没有数据</div>
      )}
    </div>
  );
}

export function DriveSync() {
  const cfg = useConfig().data?.config;
  const [dir, setDir] = useState(cfg?.syncDir || guess());
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const host = cfg?.mode === "host";

  const check = async (d = dir) => {
    setErr("");
    setPlan(null);
    if (!d.trim()) return;
    try {
      setPlan(await desk.syncPlan(d.trim()));
    } catch (e) {
      setErr(errText(e));
    }
  };
  useEffect(() => {
    if (host && cfg?.syncDir) check(cfg.syncDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const run = async (direction: "auto" | "push" | "pull") => {
    setBusy(true);
    setErr("");
    try {
      const r = await desk.syncRun(dir.trim(), direction);
      say(r.message + (r.assets_copied ? `，复制了 ${r.assets_copied} 个附件` : ""));
      if (r.action === "pull") await qc.invalidateQueries();
      else qc.invalidateQueries({ queryKey: ["config"] });
      await check();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!host)
    return (
      <p className="text-[13px] text-muted">
        这台电脑是「连接到主机」模式，数据在主机上。要带着数据出差，请在主机上同步到外置硬盘；或者在这里把模式改成「本机存储」，数据文件夹选外置硬盘上的文件夹。
      </p>
    );

  const a = plan?.action;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <label className={cx(inputCls, "flex grow items-center gap-2")}>
          <HardDrive className="size-4 shrink-0 text-faint" />
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && check()}
            placeholder={guess()}
            className="min-w-0 grow bg-transparent outline-none"
            aria-label="外置硬盘上的文件夹"
          />
        </label>
        <Button onClick={() => check()} disabled={busy}>
          <RefreshCw className="size-4" />
          检查
        </Button>
      </div>
      {plan && (
        <>
          <div className="flex items-stretch gap-3">
            <Side title="本机" s={plan.local} />
            <div className="grid shrink-0 place-items-center text-faint [&_svg]:size-5">{a === "pull" ? <ArrowLeft /> : a === "push" ? <ArrowRight /> : <span className="text-xs">⇄</span>}</div>
            <Side title="外置硬盘" s={plan.remote} />
          </div>
          <p className={cx("text-[13px]", a === "conflict" || a === "choose" ? "text-warn-fg" : "text-muted")}>{plan.message}</p>
          <div className="flex flex-wrap gap-2">
            {a === "conflict" || a === "choose" ? (
              <>
                <Button tone="primary" disabled={busy} onClick={() => run("push")}>
                  用本机的（覆盖外置硬盘）
                </Button>
                <Button disabled={busy} onClick={() => run("pull")}>
                  用外置硬盘的（覆盖本机）
                </Button>
              </>
            ) : (
              <Button tone="primary" disabled={busy || a === "none"} onClick={() => run("auto")}>
                {busy ? "正在同步…" : a === "push" ? "复制到外置硬盘" : a === "pull" ? "用外置硬盘的更新本机" : "已经一致"}
              </Button>
            )}
          </div>
        </>
      )}
      <ErrorText>{err}</ErrorText>
      <div className="rounded-xl bg-surface-2/60 px-4 py-3 text-[12.5px] leading-relaxed text-muted">
        <b className="text-fg-2">出差怎么用</b>
        <br />
        1. 走之前在这台电脑上点同步，把数据复制到外置硬盘。
        <br />
        2. 硬盘插到笔记本（Windows 或 Mac 都行）：在那台的「设置」里选「本机存储」，数据文件夹直接填硬盘上的这个文件夹；或者那台也用自己的文件夹，在这里点同步。
        <br />
        3. 回来后在这台电脑上再点一次同步，出差时的修改就回来了。
        <br />
        被覆盖的一边会先备份到它的 backups 文件夹。同步和拔硬盘之前，先退出另一台电脑上正在用这块硬盘的 xpanel。
      </div>
    </div>
  );
}
