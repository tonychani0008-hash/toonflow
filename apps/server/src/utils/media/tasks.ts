import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, writeAtomic } from "@toonflow/file";
import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import { z } from "zod";
import conf from "@/utils/conf";
import { generateMedia } from "@/utils/media/generation";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";

const mediaTypeSchema = z.enum(["image", "video", "audio"]);
const taskSchema = z.object({
  id: z.uuid(), directory: z.string(), canvasId: z.string(), mediaType: mediaTypeSchema, outputDirectory: z.string(),
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  startedAt: z.number(), finishedAt: z.number().optional(), error: z.string().optional(),
  results: z.array(z.object({ path: z.string(), mimeType: z.string(), mediaType: mediaTypeSchema })).optional(),
});
type MediaTask = z.infer<typeof taskSchema>;
type TaskQuery = Pick<MediaTask, "directory" | "canvasId" | "mediaType" | "outputDirectory"> & { id?: string };
type TaskEntry = { task: MediaTask; controller: AbortController; done?: Promise<void> };
const tasks = new Map<string, TaskEntry>();

async function taskPath(query: TaskQuery) {
  const canvas = await resolveWorkspacePath(query.directory, query.canvasId, true);
  const output = await resolveWorkspacePath(query.directory, query.outputDirectory, true);
  const identity = JSON.stringify([canvas.path, query.mediaType, output.path]);
  const key = createHash("sha256").update(process.platform === "win32" ? identity.toLowerCase() : identity).digest("hex");
  return resolve(dirname(conf.path), "mediaTasks", `${key}.json`);
}

function saveTask(path: string, task: MediaTask) {
  return writeAtomic(path, JSON.stringify(task, null, 2), { mode: 0o600 });
}

export async function getMediaTask(query: TaskQuery): Promise<MediaTask | null> {
  const path = await taskPath(query);
  let task = tasks.get(path)?.task;
  if (!task) {
    try { task = taskSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    // ACT: 页面断线不影响任务；服务重启后只恢复已完成结果，绝不自动重复提交收费请求。
    if (task.status === "running") {
      task.status = "failed";
      task.finishedAt = Date.now();
      task.error = "服务已重启，生成等待已中断，请先确认供应商任务结果再决定是否重新生成";
      await saveTask(path, task);
    }
  }
  if (query.id && query.id !== task.id) throw Object.assign(new Error("生成任务已被替换"), { status: 409 });
  return task;
}

export async function startMediaTask(query: Omit<TaskQuery, "id">, request: MediaGenerationRequest) {
  const path = await taskPath(query);
  const release = lockWorkspaceFiles([path]);
  try {
    const previous = await getMediaTask(query);
    if (previous?.status === "running") throw Object.assign(new Error("此节点已有生成任务，请等待完成或先停止"), { status: 409 });
    const task: MediaTask = { ...query, id: crypto.randomUUID(), status: "running", startedAt: Date.now() };
    const entry: TaskEntry = { task, controller: new AbortController() };
    tasks.set(path, entry);
    try {
      await mkdir(dirname(path), { recursive: true });
      await saveTask(path, task);
    } catch (error) { tasks.delete(path); throw error; }
    // ACT: 每个画布节点只保留最近一条任务；连接关闭只结束前端等待，显式停止才取消服务端任务。
    entry.done = (async () => {
      const completed = { ...task };
      try {
        completed.results = await generateMedia(query.directory, query.mediaType, request, entry.controller.signal);
        completed.status = "succeeded";
      } catch (error) {
        completed.status = entry.controller.signal.aborted ? "cancelled" : "failed";
        completed.error = completed.status === "cancelled" ? "生成已取消" : error instanceof Error ? error.message : "媒体生成失败";
      }
      completed.finishedAt = Date.now();
      try { await saveTask(path, completed); }
      catch (error) {
        completed.status = "failed";
        completed.error = `生成任务状态保存失败：${error instanceof Error ? error.message : String(error)}`;
        console.error(completed.error, { taskId: task.id });
      }
      entry.task = completed;
    })();
    return task;
  } finally { release(); }
}

export async function cancelMediaTask(query: TaskQuery & { id: string }) {
  const task = await getMediaTask(query);
  if (!task) throw Object.assign(new Error("生成任务不存在"), { status: 404 });
  const entry = tasks.get(await taskPath(query));
  if (entry?.task.id === task.id && task.status === "running") {
    entry.controller.abort();
    await entry.done;
  }
  return entry?.task.id === task.id ? entry.task : task;
}
