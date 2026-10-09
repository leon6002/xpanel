/* 外置硬盘同步：每台电脑用自己的数据文件夹，外置硬盘交接。
   离开前把本机的数据备份到外置硬盘；到另一台电脑从外置硬盘合并，按条目来，两边都改过的逐条选。
   备份和合并走 /api/v1/backup，桌面版和浏览器都能用；外置硬盘上的文件夹只能在主机的桌面版里改。 */
import { HardDrive, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { desk, drive, errText, isApp } from "../lib/api";
import { qc, setConfig, useConfig } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { ago } from "../lib/logic";
import { useUi } from "../lib/store";
import { typeName, type DriveBackup, type DriveStatus, type MergeChange, type MergeChoice, type MergePreview } from "../lib/types";
import { cx } from "../lib/cx";
import { Button, Chip, ErrorText, inputCls } from "../components/ui";

const say = (t: string) => useUi.getState().say(t);
const guess = () => (/Mac/i.test(navigator.platform) ? "/Volumes/外置硬盘/xpanel" : "F:\\xpanel");
const size = (n: number) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + " GB" : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

export function openDriveSync() {
  openDialog((close) => (
    <Dialog wide title="外置硬盘同步" desc="每台电脑用自己的数据，外置硬盘交接：离开前备份过去，到另一台电脑合并进来。合并按条目来，两边都改过的由你逐条选。" onClose={close}>
      <DriveSync />
    </Dialog>
  ));
}

const KIND: Record<MergeChange["kind"], { name: string; tone: "plain" | "warn" | "danger" }> = {
  add: { name: "新增", tone: "plain" },
  update: { name: "修改", tone: "plain" },
  delete: { name: "删除", tone: "danger" },
  conflict: { name: "两边都改过", tone: "warn" },
};

function Side({ title, tag, children }: { title: string; tag?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-xl bg-surface-2 px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
        <span className="truncate">{title}</span>
        {tag && <span className="shrink-0 rounded-md bg-accent-soft px-1.5 text-[11px] font-normal text-accent-strong">{tag}</span>}
      </div>
      <div className="text-[13px] leading-relaxed text-muted">{children}</div>
    </div>
  );
}

const backupLine = (b: DriveBackup) => `${b.items} 条 · ${b.assets} 个附件`;

/** 一条改动：左边是什么改动、在哪台电脑改的，右边选用哪边 */
function Row({ c, value, onChange }: { c: MergeChange; value: MergeChoice; onChange: (v: MergeChoice) => void }) {
  const k = KIND[c.kind];
  const options: [MergeChoice, string][] = [
    ["remote", c.kind === "delete" ? "本机也删除" : "用外置硬盘的"],
    ["local", "保留本机的"],
  ];
  if (c.kind === "conflict" && !c.remoteDeleted) options.push(["both", "两份都留"]);
  const where = c.originName && !c.originIsMe ? `在「${c.originName}」` : "";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3 py-2.5 hover:bg-surface-2/70">
      <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <Chip tone={k.tone}>{k.name}</Chip>
          <span className="truncate text-[13.5px] text-fg" title={c.title}>
            {c.title || "（没有标题）"}
          </span>
        </div>
        <div className="truncate text-xs text-faint">
          {typeName(c.type)}
          {" · "}
          {c.kind === "conflict" ? (
            <>
              外置硬盘：{c.remoteDeleted ? "已删除" : `${where}${ago(c.remoteAt)}改的`}
              {" · "}
              本机：{c.localDeleted ? "已删除" : `${ago(c.localAt ?? 0)}改的`}
              {c.localTitle && c.localTitle !== c.title ? `（本机标题「${c.localTitle}」）` : ""}
            </>
          ) : (
            <>
              {where}
              {ago(c.remoteAt)}
              {k.name}
            </>
          )}
        </div>
      </div>
      <div role="radiogroup" aria-label={`「${c.title}」用哪边`} className="flex shrink-0 rounded-[10px] bg-surface-2 p-[3px]">
        {options.map(([v, name]) => (
          <button
            key={v}
            role="radio"
            aria-checked={value === v}
            onClick={() => onChange(v)}
            className={cx("rounded-lg px-2.5 py-1 text-[12.5px] transition-colors", value === v ? "bg-surface font-semibold text-fg shadow-1" : "text-muted hover:text-fg")}
          >
            {name}
          </button>
        ))}
      </div>
    </li>
  );
}

export function DriveSync() {
  const cfg = useConfig().data?.config;
  // 文件夹记在主机的桌面版配置里：只有主机的桌面版能改
  const canEdit = isApp && cfg?.mode === "host";
  const [dir, setDir] = useState(cfg?.syncDir || "");
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "check" | "backup" | "merge">("");
  const [sure, setSure] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    setSure(false);
    const s = await drive.status();
    setStatus(s);
    setPreview(null);
    if (s.dir && !dir) setDir(s.dir);
    if (s.available && s.needsMerge) {
      const p = await drive.preview();
      setPreview(p);
      setChoices(Object.fromEntries(p.changes.map((c) => [c.id, c.choice])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const guard = async (what: typeof busy, f: () => Promise<void>) => {
    setBusy(what);
    setErr("");
    try {
      await f();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    guard("check", load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = () =>
    guard("check", async () => {
      if (canEdit) {
        const r = await desk.setSyncDir(dir.trim());
        setConfig({ config: r.config });
      }
      await load();
    });

  const backup = (force: boolean) =>
    guard("backup", async () => {
      const r = await drive.backup(force);
      if (r.needsMerge) {
        await load();
        return;
      }
      say(`已备份到外置硬盘：${r.manifest?.items ?? 0} 条` + (r.copiedFiles ? `，新复制 ${r.copiedFiles} 个附件` : ""));
      await load();
    });

  const merge = () =>
    guard("merge", async () => {
      if (!preview) return;
      const r = await drive.merge(preview.latest.file, choices);
      const n = Object.values(r.applied || {}).reduce((a, b) => a + b, 0);
      say(`已合并 ${n} 条` + (r.kept ? `，保留本机的 ${r.kept} 条` : "") + (r.copiedFiles ? `，补了 ${r.copiedFiles} 个附件` : ""));
      await qc.invalidateQueries();
      await load();
    });

  const changes = preview?.changes ?? [];
  const conflicts = changes.filter((c) => c.kind === "conflict").length;
  const taking = useMemo(() => changes.filter((c) => (choices[c.id] ?? "local") !== "local").length, [changes, choices]);
  const setAll = (v: "remote" | "local") => setChoices(Object.fromEntries(changes.map((c) => [c.id, v])));

  const last = status?.last;
  const fromOther = !!last && !!status && last.replicaId !== status.replica.id;
  const aligned = !!last && !!status?.base && status.base.file === last.file;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <label className={cx(inputCls, "flex grow items-center gap-2")}>
          <HardDrive className="size-4 shrink-0 text-faint" />
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && check()}
            placeholder={canEdit ? guess() : "还没设置"}
            readOnly={!canEdit}
            className="min-w-0 grow bg-transparent font-mono outline-none"
            aria-label="外置硬盘上的文件夹"
          />
        </label>
        <Button onClick={check} disabled={!!busy}>
          <RefreshCw className={cx("size-4", busy === "check" && "animate-spin")} />
          检查
        </Button>
      </div>
      {!canEdit && (
        <p className="-mt-2 text-xs text-faint">
          {isApp ? "这台电脑是「连接到主机」模式：数据在主机上，硬盘要插在主机上，文件夹也在主机的 xpanel 里改。" : "硬盘要插在主机上；文件夹在主机的桌面版里改（命令行启动的用 xp serve --drive）。"}
        </p>
      )}

      {status && (
        <div className="flex flex-wrap items-stretch gap-3">
          <Side title={`本机 · ${status.replica.name || "这台电脑"}`}>
            {status.base ? (
              <>
                上次和外置硬盘对齐：{ago(status.base.at)}
                {status.base.replicaId !== status.replica.id && status.base.replicaName ? `（合并了「${status.base.replicaName}」的备份）` : ""}
              </>
            ) : (
              "还没和外置硬盘同步过"
            )}
          </Side>
          <Side title="外置硬盘" tag={status.needsMerge ? "有别的电脑的新改动" : undefined}>
            {!status.dir ? (
              "还没设置文件夹"
            ) : !status.available ? (
              "没找到这个文件夹，硬盘插上了吗？"
            ) : last ? (
              <>
                「{last.replicaName || "另一台电脑"}」{ago(last.at)}备份的{fromOther ? "" : "（就是这台）"}
                <br />
                {backupLine(last)}
                {aligned && !status.needsMerge ? " · 本机已对齐" : ""}
              </>
            ) : (
              "还没有备份"
            )}
          </Side>
        </div>
      )}

      {preview && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="grow text-[13px] text-fg-2">
              {changes.length ? (
                <>
                  和本机不一样的有 <b>{changes.length}</b> 条{conflicts ? `，其中 ${conflicts} 条两边都改过` : ""}
                </>
              ) : (
                "外置硬盘上的备份和本机没有不一样的条目"
              )}
              {preview.assets.missing ? `；还会补 ${preview.assets.missing} 个附件（${size(preview.assets.bytes)}）` : ""}
            </p>
            {changes.length > 1 && (
              <>
                <Button tone="ghost" onClick={() => setAll("remote")}>
                  全部用外置硬盘的
                </Button>
                <Button tone="ghost" onClick={() => setAll("local")}>
                  全部保留本机的
                </Button>
              </>
            )}
          </div>
          {preview.first && changes.length > 0 && <p className="text-xs text-warn-fg">第一次和这块硬盘合并，分不出是哪边改的：两边不一样的都算「两边都改过」，默认选了较新的那边，请过一遍。</p>}
          {changes.length > 0 && (
            <ul className="scroll-quiet -mx-3 flex max-h-[38vh] flex-col overflow-y-auto">
              {changes.map((c) => (
                <Row key={c.id} c={c} value={choices[c.id] ?? "local"} onChange={(v) => setChoices((m) => ({ ...m, [c.id]: v }))} />
              ))}
            </ul>
          )}
        </div>
      )}

      <ErrorText>{err}</ErrorText>

      {status?.available && (
        <div className="flex flex-wrap items-center gap-2">
          {preview ? (
            <>
              <Button tone="primary" disabled={!!busy} onClick={merge}>
                {busy === "merge" ? "正在合并…" : changes.length ? (taking ? `合并 ${taking} 条` : "完成（全部保留本机的）") : "完成合并"}
              </Button>
              <span className="grow" />
              <Button tone="ghost" disabled={!!busy} onClick={() => (sure ? backup(true) : setSure(true))} title="外置硬盘上那份备份里没合并的改动，之后不会再提示">
                {busy === "backup" ? "正在备份…" : sure ? "再点一次：不合并，直接备份" : "不合并，直接备份"}
              </Button>
            </>
          ) : (
            <Button tone="primary" disabled={!!busy} onClick={() => backup(false)}>
              {busy === "backup" ? "正在备份…" : "备份到外置硬盘"}
            </Button>
          )}
        </div>
      )}

      <div className="rounded-xl bg-surface-2/60 px-4 py-3 text-[12.5px] leading-relaxed text-muted">
        <b className="text-fg-2">换电脑怎么用</b>
        <br />
        1. 离开这台电脑前点「备份到外置硬盘」。
        <br />
        2. 硬盘插到另一台电脑（Windows 或 Mac 都行，各用各的数据文件夹），打开这里：会列出和那台不一样的条目，选好后点「合并」。
        <br />
        3. 在那台电脑上用完，同样先「备份到外置硬盘」，回来再合并。
        <br />
        合并前本机会自动留一份备份（数据文件夹的 backups/premerge-*.db）；附件只增不删。拔硬盘前等备份提示出现。
      </div>
    </div>
  );
}
