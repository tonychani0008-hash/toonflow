type MediaInput =
  | { type: "url"; url: string; mimeType?: string }
  | { type: "base64"; data: string; mimeType: string }
  | { type: "binary"; data: Uint8Array; mimeType: string };
type VideoRequest = {
  model: string; prompt: string; images?: MediaInput[]; videos?: MediaInput[]; audios?: MediaInput[];
  firstFrame?: MediaInput; lastFrame?: MediaInput; mode?: string | string[];
  duration?: number; resolution?: string; ratio?: string; generateAudio?: boolean; watermark?: boolean;
  other?: Record<string, unknown>;
};
type Context = {
  config: { baseUrl?: string; steps?: number };
  signal?: AbortSignal;
  tool: { fetch: typeof fetch; errorMessage(value: unknown): string };
};
type VideoJob = { id?: string; status?: string; error?: unknown };

function wait(signal: AbortSignal, milliseconds: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function mediaPart(context: Context, input: MediaInput, type: string, signal: AbortSignal) {
  let bytes: Uint8Array;
  let mimeType = input.mimeType ?? "";
  if (input.type === "url") {
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("参考媒体地址必须是不含凭据的 HTTP(S) 地址");
    const response = await context.tool.fetch(url, { signal });
    if (!response.ok) throw new Error(`读取参考媒体失败：HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > 100 * 1024 * 1024) throw new Error("单个参考媒体不能超过 100 MB");
    bytes = new Uint8Array(await response.arrayBuffer());
    mimeType = response.headers.get("content-type")?.split(";")[0] || mimeType;
  } else if (input.type === "binary") bytes = input.data;
  else {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(input.data);
    mimeType = match?.[1] ?? mimeType;
    const data = (match?.[2] ?? input.data).replace(/\s/g, "");
    if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("参考媒体 Base64 无效");
    bytes = Buffer.from(data, "base64");
  }
  if (!bytes.byteLength || bytes.byteLength > 100 * 1024 * 1024 || !/^(image|video|audio)\/[a-z0-9.+-]+$/i.test(mimeType) || !mimeType.startsWith(type + "/")) throw new Error(`参考媒体须为非空且不超过 100 MB 的 ${type} 文件`);
  return { bytes, mimeType };
}

async function readJob(context: Context, url: string, signal: AbortSignal, init?: RequestInit): Promise<VideoJob> {
  const response = await context.tool.fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
  const data = await response.json() as VideoJob;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("H3 任务响应格式无效");
  if (!response.ok || data.error) throw Object.assign(new Error(context.tool.errorMessage(data) || `H3 请求失败：HTTP ${response.status}`), { status: response.status });
  return data;
}

export default {
  id: "localMinimaxH3",
  label: "MiniMax H3（本地 ref2va）",
  version: "2.0.1",
  readme: "[本地 Web 页面](http://192.168.2.16:30013/)。当前部署仅开放 ref2va，至少需要一个图片、视频或音频参考；参考图按顺序对应 <Picture 1>、<Picture 2>。默认推理步数 8，可在下方修改；服务端 LoRA 的 9 步建议不会覆盖这里的设置。时长 4～15 秒，输出音画同步视频，短边固定 768。每类参考上限 64，沿用 Toonflow 输入限制。",
  rules: [
    { type: "input", field: "baseUrl", title: "服务地址", value: "http://192.168.2.16:30012/v1", validate: [{ required: true, message: "请填写服务地址" }] },
    { type: "inputNumber", field: "steps", title: "推理步数", value: 8, props: { min: 1, max: 200, step: 1, precision: 0 } },
  ],
  models: [{
    id: "/home/dskj/ws_zl/ai_images/MiniMax-H3",
    label: "MiniMax H3 ref2va（本地）",
    type: "video",
    mode: [["imageReference:64", "videoReference:64", "audioReference:64"]],
    audio: true,
    durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768p"] }],
  }],
  async generateVideo(this: Context, request: VideoRequest) {
    if (request.model !== "/home/dskj/ws_zl/ai_images/MiniMax-H3") throw new Error("所选 H3 模型与本地部署不匹配");
    if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("请输入视频提示词");
    const images = request.images ?? [];
    const videos = request.videos ?? [];
    const audios = request.audios ?? [];
    if (!images.length && !videos.length && !audios.length) throw new Error("ref2va 至少需要一个图片、视频或音频参考");
    if ([images, videos, audios].some(items => items.length > 64)) throw new Error("每类参考媒体最多 64 个");
    if (typeof request.mode === "string") throw new Error("当前 H3 部署仅支持混合参考 ref2va 模式");
    if (request.generateAudio === false) throw new Error("当前 H3 部署固定生成音画同步视频，不支持关闭音频");
    if (request.watermark !== undefined || (request.other && Object.keys(request.other).length)) throw new Error("此适配器不支持水印选项或额外参数");
    if (request.resolution !== undefined && request.resolution !== "768p") throw new Error("当前 H3 部署固定输出短边 768");
    const seconds = request.duration ?? 5;
    if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) throw new Error("H3 时长必须为 4～15 秒的整数");
    const steps = this.config.steps ?? 8;
    if (!Number.isInteger(steps) || steps < 1 || steps > 200) throw new Error("推理步数必须为 1～200 的整数");
    const ratio = request.ratio ?? "16:9";
    const size = ({ "21:9": "2560x1080", "16:9": "1280x720", "4:3": "1024x768", "1:1": "1024x1024", "3:4": "768x1024", "9:16": "720x1280" } as Record<string, string>)[ratio];
    if (!size) throw new Error("H3 仅支持 21:9、16:9、4:3、1:1、3:4、9:16");
    const base = new URL(this.config.baseUrl?.trim() || "http://192.168.2.16:30012/v1");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("服务地址无效");
    const baseUrl = base.href.replace(/\/+$/, "");
    const signal = this.signal ?? new AbortController().signal;
    const boundary = `----toonflow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const parts: BlobPart[] = [];
    const fields = { model: request.model, prompt: request.prompt.trim(), task: "ref2va", seconds, size, num_inference_steps: steps, extra_body: JSON.stringify({ target: { aspect_ratio: ratio } }) };
    for (const [name, value] of Object.entries(fields)) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const references: { field: string; input: MediaInput; type: string }[] = [
      ...(request.firstFrame ? [{ field: "input_reference", input: request.firstFrame, type: "image" }] : []),
      ...(request.lastFrame ? [{ field: "last_frame", input: request.lastFrame, type: "image" }] : []),
      ...images.map(input => ({ field: "reference_image", input, type: "image" })),
      ...videos.map(input => ({ field: "reference_video", input, type: "video" })),
      ...audios.map(input => ({ field: "reference_audio", input, type: "audio" })),
    ];
    for (const [index, reference] of references.entries()) {
      const { bytes, mimeType } = await mediaPart(this, reference.input, reference.type, signal);
      const extension = mimeType.split("/")[1].replace(/[^a-z0-9]/gi, "");
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${reference.field}"; filename="reference${index}.${extension}"\r\nContent-Type: ${mimeType}\r\n\r\n`, new Uint8Array(bytes), "\r\n");
    }
    parts.push(`--${boundary}--\r\n`);
    const created = await readJob(this, `${baseUrl}/videos`, signal, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: new Blob(parts) });
    const id = created.id;
    if (typeof id !== "string" || !id.trim()) throw new Error("H3 未返回视频任务 ID");
    let job = created;
    let failures = 0;
    // ACT: 12 秒视频实际可能超过 30 分钟；等待至完成或宿主显式取消，只重试查询、不重复提交。
    try {
      while (true) {
        if (job.status === "completed") return [{ mediaType: "video" as const, type: "url" as const, url: `${baseUrl}/videos/${encodeURIComponent(id)}/content`, mimeType: "video/mp4" }];
        if (!["queued", "in_progress"].includes(job.status ?? "")) throw new Error(this.tool.errorMessage(job) || `H3 任务状态：${job.status ?? "空"}`);
        await wait(signal, 3000);
        try { job = await readJob(this, `${baseUrl}/videos/${encodeURIComponent(id)}`, signal); failures = 0; }
        catch (cause) {
          signal.throwIfAborted();
          const status = (cause as { status?: number }).status;
          if ((status === undefined || status === 429 || status >= 500) && ++failures <= 3) continue;
          throw cause;
        }
      }
    } catch (cause) {
      const message = signal.aborted ? "H3 等待已取消" : this.tool.errorMessage(cause) || "H3 查询失败";
      throw new Error(`${message}。任务 ID：${id}；请查询原任务，不要重复生成。`);
    }
  },
};
