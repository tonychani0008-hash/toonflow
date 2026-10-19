type MediaInput =
  | { type: "url"; url: string; mimeType?: string }
  | { type: "base64"; data: string; mimeType: string }
  | { type: "binary"; data: Uint8Array; mimeType: string };
type ImageRequest = {
  model: string; prompt: string; images?: MediaInput[]; mask?: MediaInput;
  n?: number; ratio?: string; size?: string; quality?: string; outputFormat?: string;
  other?: Record<string, unknown>;
};
type Context = {
  config: { baseUrl?: string; steps?: number; cfg?: number };
  signal?: AbortSignal;
  tool: { fetch: typeof fetch; errorMessage(value: unknown): string };
};
type ImageAsset = { mediaType: "image"; type: "base64"; data: string; mimeType: string };

function dimensions(size = "1K", ratio = "1:1") {
  const pixels = /^(\d+)x(\d+)$/i.exec(size);
  if (pixels) {
    const width = Number(pixels[1]);
    const height = Number(pixels[2]);
    if (width < 16 || height < 16 || width > 2048 || height > 2048 || width % 16 || height % 16) throw new Error("MageFlow 图片宽高须为 16～2048 的 16 倍数");
    return `${width}x${height}`;
  }
  const edge = ({ "1K": 1024, "2K": 2048 } as Record<string, number>)[size.toUpperCase()];
  const match = /^([1-9]\d{0,3}):([1-9]\d{0,3})$/.exec(ratio);
  if (!edge || !match) throw new Error("请选择 1K、2K 或合法的像素尺寸及画面比例");
  const width = Number(match[1]);
  const height = Number(match[2]);
  return `${Math.max(16, Math.floor(edge * width / Math.max(width, height) / 16) * 16)}x${Math.max(16, Math.floor(edge * height / Math.max(width, height) / 16) * 16)}`;
}

async function imagePart(context: Context, input: MediaInput, signal: AbortSignal) {
  let bytes: Uint8Array;
  let mimeType = input.mimeType ?? "";
  if (input.type === "url") {
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("参考图地址必须是不含凭据的 HTTP(S) 地址");
    const response = await context.tool.fetch(url, { signal });
    if (!response.ok) throw new Error(`读取参考图失败：HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > 20 * 1024 * 1024) throw new Error("参考图不能超过 20 MB");
    bytes = new Uint8Array(await response.arrayBuffer());
    mimeType = response.headers.get("content-type")?.split(";")[0] || mimeType;
  } else if (input.type === "binary") bytes = input.data;
  else {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(input.data);
    mimeType = match?.[1] ?? mimeType;
    const data = (match?.[2] ?? input.data).replace(/\s/g, "");
    if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("参考图 Base64 无效");
    bytes = Buffer.from(data, "base64");
  }
  if (!bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024 || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) throw new Error("参考图须为非空且不超过 20 MB 的图片");
  return { bytes, mimeType };
}

export default {
  id: "localMageflow",
  label: "MageFlow（本地）",
  version: "2.0.0",
  readme: "[本地 Web 页面](http://192.168.2.16:7860/)。支持文生图、单图及最多 6 图编辑；步数默认 8、CFG 默认 3，可在下方修改。1K/2K 表示长边，宽高按 16 对齐。编辑模型需要至少一张参考图，不支持遮罩重绘。",
  rules: [
    { type: "input", field: "baseUrl", title: "服务地址", value: "http://192.168.2.16:7861/v1", validate: [{ required: true, message: "请填写服务地址" }] },
    { type: "inputNumber", field: "steps", title: "推理步数", value: 8, props: { min: 1, max: 50, step: 1, precision: 0 } },
    { type: "inputNumber", field: "cfg", title: "CFG", value: 3, props: { min: 0, max: 20, step: 0.1, precision: 1 } },
  ],
  models: [
    {
      "id": "mage-flow-turbo",
      "label": "MageFlow Turbo（文生图）",
      "type": "image",
      "mode": [
        "text"
      ],
      "imageSizes": [
        "1K",
        "2K"
      ],
      "imageRatios": [
        "1:1",
        "16:9",
        "9:16",
        "4:3",
        "3:4",
        "3:2",
        "2:3"
      ]
    },
    {
      "id": "mage-flow-edit-turbo",
      "label": "MageFlow Edit Turbo（图片编辑）",
      "type": "image",
      "mode": [
        "singleImage",
        "multiReference"
      ],
      "imageSizes": [
        "1K",
        "2K"
      ],
      "imageRatios": [
        "1:1",
        "16:9",
        "9:16",
        "4:3",
        "3:4",
        "3:2",
        "2:3"
      ]
    }
  ],
  async generateImage(this: Context, request: ImageRequest): Promise<ImageAsset[]> {
    if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("请输入图片提示词");
    const editing = request.model === "mage-flow-edit-turbo";
    if (!editing && request.model !== "mage-flow-turbo") throw new Error("MageFlow 模型不存在");
    const images = request.images ?? [];
    if ((!editing && images.length) || (editing && (!images.length || images.length > 6))) throw new Error(editing ? "MageFlow 编辑需要 1～6 张参考图" : "文生图模型不支持参考图，请选择编辑模型");
    if (request.mask || request.quality !== undefined || (request.other && Object.keys(request.other).length)) throw new Error("此适配器不支持遮罩、画质档位或额外参数");
    const steps = this.config.steps ?? 8;
    const cfg = this.config.cfg ?? 3;
    if (!Number.isInteger(steps) || steps < 1 || steps > 50) throw new Error("推理步数必须为 1～50 的整数");
    if (!Number.isFinite(cfg) || cfg < 0 || cfg > 20) throw new Error("CFG 必须在 0～20 之间");
    const n = request.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error("一次生成数量必须为 1～8");
    const outputFormat = request.outputFormat ?? "png";
    if (!["png", "jpeg", "webp"].includes(outputFormat)) throw new Error("输出格式仅支持 png、jpeg、webp");
    const base = new URL(this.config.baseUrl?.trim() || "http://192.168.2.16:7861/v1");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("服务地址无效");
    const baseUrl = base.href.replace(/\/+$/, "");
    const fields = { model: request.model, prompt: request.prompt.trim(), n, size: dimensions(request.size, request.ratio), response_format: "b64_json", output_format: outputFormat, steps, cfg };
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    let body: string | Blob = JSON.stringify(fields);
    let contentType = "application/json";
    if (editing) {
      const boundary = `----toonflow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
      const parts: BlobPart[] = [];
      for (const [name, value] of Object.entries(fields)) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      for (const [index, input] of images.entries()) {
        const { bytes, mimeType } = await imagePart(this, input, signal);
        const field = index === 0 ? "image" : "extra_images";
        const extension = mimeType.split("/")[1];
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="reference${index}.${extension}"\r\nContent-Type: ${mimeType}\r\n\r\n`, new Uint8Array(bytes), "\r\n");
      }
      parts.push(`--${boundary}--\r\n`);
      body = new Blob(parts);
      contentType = `multipart/form-data; boundary=${boundary}`;
    }
    const response = await this.tool.fetch(`${baseUrl}/images/${editing ? "edits" : "generations"}`, { method: "POST", headers: { "Content-Type": contentType }, body, signal });
    const data = await response.json() as { error?: unknown; data?: { b64_json?: string; uniform_white?: boolean }[] };
    if (!response.ok || data.error) throw new Error(this.tool.errorMessage(data) || `MageFlow 请求失败：HTTP ${response.status}`);
    if (!Array.isArray(data.data) || !data.data.length) throw new Error("MageFlow 未返回图片");
    return data.data.map(item => {
      if (item.uniform_white) throw new Error("MageFlow 内容审核返回了纯白图片，请调整提示词");
      if (typeof item.b64_json !== "string" || !item.b64_json) throw new Error("MageFlow 返回的图片编码无效");
      return { mediaType: "image", type: "base64", data: item.b64_json, mimeType: `image/${outputFormat}` };
    });
  },
};
