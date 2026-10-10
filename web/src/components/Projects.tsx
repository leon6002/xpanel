/* 项目（逻辑在 lib/projects.ts）：
   - ProjectBar：首页顶上的一排，点哪个整页就只看那个项目的；「全部」看所有
   - ProjectPick：一条上的小标签，显示它属于哪个项目（自己认的会标出来），点开可以改
   - openProject：新建、编辑一个项目（名称、状态、关键词、这台电脑上的文件夹、说明） */
import * as DM from "@radix-ui/react-dropdown-menu";
import { Box, Check, FolderOpen, Pencil, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { errText, isApp, openTarget } from "../lib/api";
import { addItem, patchItem, removeItem, useAppState, useThisDevice } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { NO_PROJECT, STATUS_NAME, dirOf, projectOf, projectPinned, projectsOf, withDir, type Project, type ProjectStatus } from "../lib/projects";
import { useUi } from "../lib/store";
import type { Item } from "../lib/types";
import { cx } from "../lib/cx";
import { Button, Chip, ConfirmButton, ErrorText, Field, Segmented, inputCls, textareaCls } from "./ui";

const say = (t: string) => useUi.getState().say(t);

export function useProjects(): Project[] {
  const items = useAppState().data?.items;
  return useMemo(() => projectsOf(items ?? []), [items]);
}

/* ---------------------------------------------------------------- 新建、编辑 */

export function openProject(p?: Project, preset?: { name?: string }) {
  openDialog((close) => <ProjectDialog p={p} preset={preset} close={close} />);
}

function ProjectDialog({ p, preset, close }: { p?: Project; preset?: { name?: string }; close: () => void }) {
  const me = useThisDevice();
  const items = useAppState().data?.items ?? [];
  const all = useProjects();
  const [name, setName] = useState(p?.name ?? preset?.name ?? "");
  const [status, setStatus] = useState<ProjectStatus>(p?.status ?? "active");
  const [kw, setKw] = useState((p?.keywords ?? []).join(" "));
  const [dir, setDir] = useState(dirOf(p, me));
  const [about, setAbout] = useState(p?.about ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const keywords = [...new Set(kw.split(/[\s,，、;；]+/).map((x) => x.trim()).filter(Boolean))];
  // 按现在填的名称和关键词，会认进来多少条（不算已经指定了别的项目的）
  const draft: Project = { id: p?.id ?? "__new__", name: name.trim(), keywords, status, about, dirs: [], item: p?.item ?? ({} as Item) };
  const hits = name.trim() ? items.filter((i) => !projectPinned(i) && projectOf(i, [...all.filter((x) => x.id !== draft.id), draft])?.id === draft.id).length : 0;
  const save = async () => {
    const n = name.trim();
    if (!n) return setErr("先填项目名称");
    if (all.some((x) => x.id !== p?.id && x.name.toLowerCase() === n.toLowerCase())) return setErr("已经有一个同名的项目了");
    setBusy(true);
    try {
      if (p) await patchItem(p.item, { title: n, body: about, keywords, status, dirs: withDir(p, me, dir) });
      else {
        const it = await addItem({ type: "project", title: n, body: about, keywords, status, dirs: dir.trim() ? [{ deviceId: me.id || undefined, hostname: me.hostname || undefined, path: dir.trim() }] : [] } as Partial<Item> & { type: "project"; title: string });
        useUi.getState().setProj(it.id);
      }
      say(p ? "项目已保存" : `建好了项目「${n}」`);
      close();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={p ? "编辑项目" : "新建项目"}
      onClose={close}
      footer={
        <>
          <Button tone="primary" disabled={busy} onClick={save}>
            保存
          </Button>
          <Button onClick={close}>取消</Button>
          <span className="grow" />
          {p && (
            <ConfirmButton
              tone="ghost"
              confirm="再点一次：删掉这个项目（里面的内容不删，只是不再归它）"
              onConfirm={async () => {
                if (useUi.getState().proj === p.id) useUi.getState().setProj(null);
                await removeItem(p.id);
                close();
                say(`删掉了项目「${p.name}」，它下面的内容都还在`);
              }}
            >
              删除项目
            </ConfirmButton>
          )}
        </>
      }
    >
      <div className="grid gap-x-3 gap-y-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Field label="名称">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="比如 智能台灯、博客改版、xpanel" aria-label="项目名称" />
        </Field>
        <Field label="状态">
          <Segmented label="状态" value={status} onChange={setStatus} options={(Object.keys(STATUS_NAME) as ProjectStatus[]).map((k) => [k, STATUS_NAME[k]])} />
        </Field>
      </div>
      <Field
        label="关键词（空格分开）"
        hint={
          <>
            标题、标签、分类或正文里出现了项目名称或这些词的，自动归到这个项目，不用一条条选；认错了可以在那一条上改。
            {name.trim() && <b className="ml-1 font-medium text-fg-2">按现在填的，会认进来 {hits} 条。</b>}
          </>
        }
      >
        <input className={inputCls} value={kw} onChange={(e) => setKw(e.target.value)} placeholder="这个项目的其他叫法，比如 台灯 lamp esp8266" aria-label="关键词" autoComplete="off" />
      </Field>
      <Field label="这台电脑上的项目文件夹（可选）" hint="交给 AI 时默认在这个文件夹里干活。每台电脑各记各的。">
        <input className={inputCls + " font-mono"} value={dir} onChange={(e) => setDir(e.target.value)} placeholder={isApp ? "比如 D:\\codes\\smart-lamp" : "在那台电脑的桌面版里填"} aria-label="项目文件夹" spellCheck={false} autoComplete="off" />
      </Field>
      <Field label="说明（可选）" hint="这个项目是做什么的、现在到哪一步、有什么约定。交给 AI 时会一起带上。">
        <textarea className={textareaCls} rows={4} value={about} onChange={(e) => setAbout(e.target.value)} aria-label="项目说明" />
      </Field>
      <ErrorText>{err}</ErrorText>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- 一条上的项目标签 */

const row = "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-2";

export function ProjectPick({ it }: { it: Item }) {
  const projects = useProjects();
  if (it.type === "project" || !projects.length) return null;
  const cur = projectOf(it, projects);
  const auto = !!cur && !projectPinned(it);
  const set = (v: string | undefined) => patchItem(it, { project: v }).then(() => say(v === NO_PROJECT ? "不归任何项目" : v ? `归到了「${projects.find((p) => p.id === v)?.name}」` : "改回按关键词自己认"));
  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-2 text-xs leading-5 whitespace-nowrap text-fg-2 hover:brightness-95 [&_svg]:size-3" title={cur ? (auto ? "按关键词自己认的，点开可以改" : "点开可以改") : "还没归到项目，点开选一个"}>
          <Box />
          {cur ? cur.name : "归到项目"}
          {auto && <span className="text-faint">自动</span>}
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="start" sideOffset={6} className="scroll-quiet z-50 max-h-[60vh] w-56 overflow-y-auto rounded-xl bg-surface p-1 shadow-3">
          {projects.map((p) => (
            <DM.Item key={p.id} className={cx(row, cur?.id === p.id ? "font-medium text-fg" : "text-fg-2")} onSelect={() => set(p.id)}>
              <span className="grow truncate">{p.name}</span>
              {p.status !== "active" && <span className="text-xs text-faint">{STATUS_NAME[p.status]}</span>}
              {cur?.id === p.id && <Check className="size-3.5" />}
            </DM.Item>
          ))}
          <DM.Item className={cx(row, "text-muted")} onSelect={() => set(NO_PROJECT)}>
            不归任何项目
          </DM.Item>
          {(projectPinned(it) || it.project === NO_PROJECT) && (
            <DM.Item className={cx(row, "text-muted")} onSelect={() => set(undefined)}>
              改回按关键词自己认
            </DM.Item>
          )}
          <DM.Item className={cx(row, "mt-1 text-muted")} onSelect={() => openProject()}>
            <Plus className="size-3.5" />
            新建项目
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

/* ---------------------------------------------------------------- 首页顶上的一排 */

export function ProjectBar({ counts, loose }: { counts: Map<string, number>; loose: number }) {
  const projects = useProjects();
  const proj = useUi((s) => s.proj);
  const setProj = useUi((s) => s.setProj);
  const me = useThisDevice();
  const chip = (on: boolean) => cx("flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] whitespace-nowrap transition-colors", on ? "bg-ink font-semibold text-on-ink" : "bg-surface text-fg-2 hover:bg-surface-3");
  const cur = projects.find((p) => p.id === proj);
  const dir = dirOf(cur, me);
  return (
    <div className="flex flex-col gap-2 px-1">
      <div role="group" aria-label="项目" className="flex flex-wrap items-center gap-1.5">
        <button aria-pressed={!proj} className={chip(!proj)} onClick={() => setProj(null)}>
          全部
        </button>
        {projects
          .filter((p) => p.status !== "done" || p.id === proj)
          .map((p) => (
            <button key={p.id} aria-pressed={proj === p.id} className={chip(proj === p.id)} onClick={() => setProj(proj === p.id ? null : p.id)} title={p.status === "active" ? undefined : STATUS_NAME[p.status]}>
              <Box className="size-3.5" />
              {p.name}
              {!!counts.get(p.id) && <span className={proj === p.id ? "opacity-70" : "text-faint"}>{counts.get(p.id)}</span>}
            </button>
          ))}
        {projects.length > 0 && loose > 0 && (
          <button aria-pressed={proj === NO_PROJECT} className={chip(proj === NO_PROJECT)} onClick={() => setProj(proj === NO_PROJECT ? null : NO_PROJECT)} title="没归到任何项目的">
            没归项目的 <span className={proj === NO_PROJECT ? "opacity-70" : "text-faint"}>{loose}</span>
          </button>
        )}
        <button className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-[13px] text-muted hover:bg-surface hover:text-fg" onClick={() => openProject()} title="比如工作上的一个项目、自己在做的一个东西。内容会按关键词自动归进去">
          <Plus className="size-3.5" />
          {projects.length ? "项目" : "建一个项目，把内容按项目分开看"}
        </button>
      </div>
      {cur && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-surface px-3.5 py-2 text-[13px]">
          <b className="font-semibold">{cur.name}</b>
          {cur.status !== "active" && <Chip>{STATUS_NAME[cur.status]}</Chip>}
          {cur.about.trim() && <span className="max-w-[520px] min-w-0 truncate text-muted">{cur.about.replace(/\s+/g, " ")}</span>}
          <span className="grow" />
          {dir && (
            <button className="flex items-center gap-1 font-mono text-xs text-muted hover:text-fg" onClick={() => openTarget(dir)} title="打开项目文件夹">
              <FolderOpen className="size-3.5" />
              {dir}
            </button>
          )}
          <button className="flex items-center gap-1 text-xs text-muted hover:text-fg" onClick={() => openProject(cur)}>
            <Pencil className="size-3.5" />
            编辑
          </button>
        </div>
      )}
    </div>
  );
}
