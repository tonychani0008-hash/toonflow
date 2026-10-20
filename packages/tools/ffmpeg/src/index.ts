import { z } from "zod";
import { chainMethods, executeRemoteFfmpeg, queryMethods, runMethods } from "@toonflow/ffmpeg/remote";
import type { FfprobeData, ToolPlugin } from "@toonflow/tools-scaffold/runtime";

const configSchema = z.strictObject({});
const nodeOutputSchema = z.strictObject({
  nodeId: z.string().min(1).max(256),
  output: z.string().min(1).max(256).describe("节点实际输出端口名，例如 video、audio 或 image"),
});
const inputSchema = z.union([z.string().min(1), nodeOutputSchema]);
const probeSchema = z.strictObject({
  path: inputSchema.describe("工作区媒体路径；画布素材优先传 {nodeId, output}，执行时直接读取节点当前输出，不转抄文件名"),
  options: z.array(z.string()).optional().describe("原生 ffprobe 选项，按参数数组原样传递"),
});
const lastFrameSchema = z.strictObject({
  source: nodeOutputSchema.describe("原始目标视频节点及其输出端口，必须先查询；不能用合并成片代替源片段"),
});
const processSchema = z.strictObject({
  options: z.strictObject({
    source: inputSchema.optional(),
    cwd: z.string().optional(),
    niceness: z.number().optional(),
    priority: z.number().optional(),
    stdoutLines: z.number().optional(),
    timeout: z.number().optional(),
  }).optional().describe("原生 fluent 构造选项；不设置固定超时"),
  steps: z.array(z.strictObject({
    method: z.enum(chainMethods),
    args: z.array(z.json()).describe("input/addInput/mergeAdd 的首个参数可传 {nodeId, output}，直接引用节点当前媒体输出；其他参数沿用 fluent 原生语法"),
    undefinedArgs: z.array(z.number().int().nonnegative()).optional().describe("需要传 undefined 的参数位置，其他参数保持原值"),
  })).default([]).describe("按 fluent-ffmpeg 顺序配置，方法及其别名沿用宿主；选项、滤镜和文件序列原样传递"),
  operation: z.strictObject({
    method: z.enum([...runMethods, ...queryMethods]),
    args: z.array(z.json()),
    undefinedArgs: z.array(z.number().int().nonnegative()).optional(),
  }).default({ method: "run", args: [] }).describe("最后执行的方法，默认 run；也可 save、screenshots、concat 或查询编码器、格式、滤镜等"),
});

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools(context) {
    async function resolveInput(input: unknown, signal?: AbortSignal): Promise<string> {
      const source = inputSchema.parse(input);
      if (typeof source === "string") return source;
      if (!context.canvas) throw new Error("引用节点输出需要打开目标画布");
      const response = await context.canvas.call({
        name: "getCanvasNodes",
        args: { nodeIds: [source.nodeId], path: ["outputs", source.output], textLimit: 4000 },
      }, signal);
      const result = z.object({
        nodes: z.array(z.object({
          id: z.literal(source.nodeId),
          value: z.object({
            dataType: z.enum(["IMAGE", "MASK", "VIDEO", "AUDIO", "FILE"]),
            value: z.object({ url: z.string().min(1).max(4000) }),
          }),
          truncated: z.array(z.unknown()).max(0),
        })).length(1),
        hasMore: z.literal(false),
      }).safeParse(response);
      if (!result.success) throw new Error(`节点 ${source.nodeId} 的 ${source.output} 没有完整可用的媒体输出，请核对当前节点，不能改用历史文件`);
      const path = result.data.nodes[0]!.value.value.url;
      if (!(await context.files.stat(path)).isFile()) throw new Error(`节点当前输出不是文件：${path}`);
      signal?.throwIfAborted();
      return path;
    }

    async function execute(request: z.infer<typeof processSchema>, signal?: AbortSignal) {
      const { source, ...options } = request.options ?? {};
      const resolvedSource = source === undefined ? undefined : await resolveInput(source, signal);
      const calls: z.infer<typeof processSchema>["steps"] = [];
      for (const call of request.steps) {
        calls.push(["input", "addInput", "mergeAdd"].includes(call.method)
          ? { ...call, args: [await resolveInput(call.args[0], signal), ...call.args.slice(1)] } : call);
      }
      const ffmpeg = await context.ffmpeg(signal);
      let details: unknown;
      let error: Error | undefined;
      let filenames: unknown;
      // ACT: 节点引用解析为路径后复用已有桥接，其余参数、输出位置和原生执行规则保持不变。
      await executeRemoteFfmpeg(ffmpeg, {
        directory: context.cwd,
        requestId: crypto.randomUUID(),
        options: { ...options, source: resolvedSource },
        calls,
        operation: request.operation,
      }, event => {
        if (event.event === "error") {
          const failure = event.args[0] as { message?: string };
          error = Object.assign(new Error(failure.message ?? "FFmpeg 执行失败"), failure);
        } else if (event.event === "result") details = event.args[0];
        else if (event.event === "filenames") filenames = event.args[0];
        else if (event.event === "end") details = { stdout: event.args[0], stderr: event.args[1], ...(filenames ? { filenames } : {}) };
      }, signal ?? new AbortController().signal);
      signal?.throwIfAborted();
      if (error) throw error;
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    }

    return [{
      name: "ffprobe",
      label: "查询媒体信息",
      description: "使用本机 FFprobe 读取工作区媒体的格式、时长、尺寸、帧率和音轨等信息，支持原生探测选项。画布素材的 path 优先使用 {nodeId, output} 引用当前节点输出。",
      parameters: z.toJSONSchema(probeSchema, { io: "input", target: "draft-07" }),
      execute(_id, params, signal) {
        const { path, options } = probeSchema.parse(params);
        return execute({ steps: [{ method: "input", args: [path] }], operation: { method: "ffprobe", args: options ? [options] : [] } }, signal);
      },
    }, {
      name: "extractLastFrame",
      label: "提取真实尾帧",
      description: "直接读取原始视频节点的当前输出，实际解码统计视频帧数并提取最后一帧为 PNG。无需传时长、帧率或帧号；跨片段衔接必须引用源片段节点，不能从合并视频估算边界或用图片生成重建尾帧。返回源路径、实际帧数、从 0 开始的末帧编号和新图片路径，可用 setImage 更新参考节点。",
      parameters: z.toJSONSchema(lastFrameSchema, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const { source } = lastFrameSchema.parse(params);
        const sourcePath = await resolveInput(source, signal);
        // ACT: 两遍扫描为 O(帧数)；实际解码计数兼容变帧率和缺失帧数元数据，不缓存整段视频。
        const probe = await execute({ steps: [{ method: "input", args: [sourcePath] }], operation: { method: "ffprobe", args: [["-count_frames"]] } }, signal);
        const media = probe.details as FfprobeData;
        const video = media.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
        const frameCount = Number(video?.nb_read_frames);
        if (!video || !Number.isSafeInteger(video.index) || !Number.isSafeInteger(frameCount) || frameCount <= 0) throw new Error("无法读取有效的视频帧数，未生成尾帧");
        signal?.throwIfAborted();
        const frameIndex = frameCount - 1;
        const path = `assets/lastFrame${crypto.randomUUID().replaceAll("-", "")}.png`;
        await context.files.mkdir("assets", true);
        // 先独占创建新文件，原生 FFmpeg 仅写入本次保留的路径，不覆盖已有素材。
        await context.files.writeFile(path, "", true);
        try {
          await execute({
            steps: [
              { method: "input", args: [sourcePath] },
              { method: "videoFilters", args: [`select=eq(n\\,${frameIndex})`] },
              { method: "frames", args: [1] },
              { method: "outputOptions", args: ["-map", `0:${video.index}`, "-fps_mode", "passthrough", "-update", "1"] },
              { method: "output", args: [path] },
            ],
            operation: { method: "run", args: [] },
          }, signal);
          if (!(await context.files.stat(path)).size) throw new Error("视频未输出有效尾帧");
          signal?.throwIfAborted();
          const details = { source, sourcePath, frameCount, frameIndex, path, mimeType: "image/png" };
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        } catch (error) {
          try { await context.files.remove(path); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], `尾帧提取失败，残留文件清理失败：${path}`); }
          throw error;
        }
      },
    }, {
      name: "ffmpeg",
      label: "处理媒体",
      description: "通过宿主 fluent-ffmpeg 处理工作区媒体。steps 原样传入链式方法及 args，支持全部宿主配置方法和别名、原始 inputOptions/outputOptions、复杂滤镜、多输入、多输出、文件序列及分片。operation 默认 run，也支持 save、screenshots、concat 和能力查询。不自动重命名输出、不限制执行时长；输出目录需已存在，文件覆盖遵循原生规则。",
      promptSnippet: "使用 ffmpeg 处理本地媒体，ffprobe 查询媒体信息，extractLastFrame 提取原始片段的真实尾帧；画布素材通过 {nodeId, output} 引用节点当前输出，按用户要求选择输出位置。",
      promptGuidelines: [
        "跨片段衔接需要上一段尾帧时，必须使用 extractLastFrame 引用上一段的原始视频节点，再将返回的 path 设为后段的参考图片。不得从合并成片估算分界帧、沿用旧尾帧或用图片生成重建；帧号从 0 开始，N 帧视频的末帧编号是 N-1。",
        '探测或合并画布素材时，先查询目标节点与输出端口，再将 {"nodeId":"实际节点 ID","output":"video"} 用作 ffprobe.path、ffmpeg 的 input/addInput/mergeAdd 首个参数或 options.source；工具在每次执行时读取当前输出，避免转抄长文件名。',
        "用户要求最新版时，以目标节点当前输出为准，idle 不表示输出过期或不存在。路径读取失败先重新查询节点输出、核对实际目录；不得自行替换为旧生成、旧降噪或旧合并文件，也不得通过模糊匹配猜测替代素材。",
        '截帧示例：{"steps":[{"method":"input","args":["assets/input.mp4"]},{"method":"seekInput","args":[1]},{"method":"frames","args":[1]},{"method":"output","args":["assets/frame.png"]}]}。',
        'inputOptions/outputOptions 按 fluent 原生语法传参，不额外拆分空格。含空格的元数据使用 args:["-metadata","title=a b"]，不要再嵌套数组。先用 operation={"method":"availableEncoders","args":[]} 等查询实际能力，不猜测本机编码器。',
        "除非用户要求覆盖，否则使用新文件名；所有显式路径及参数、滤镜和媒体清单中引用的文件都应位于当前工作区。",
      ],
      parameters: z.toJSONSchema(processSchema, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      execute(_id, params, signal) {
        return execute(processSchema.parse(params), signal);
      },
    }];
  },
};

export default plugin;
