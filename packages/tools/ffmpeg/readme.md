# FFmpeg 媒体处理

为 Agent 提供 `ffmpeg`、`ffprobe` 和 `extractLastFrame`，直接连接 `context.ffmpeg()`，复用插件市场配置的执行程序及节点已有的调用桥接。

## 调用方式

`ffprobe` 接收文件路径和可选的原生参数：

```json
{ "path": "assets/input.mp4", "options": ["-count_frames"] }
```

处理画布素材时，优先引用节点的当前输出，避免转抄长文件名：

```json
{ "path": { "nodeId": "实际节点 ID", "output": "video" } }
```

`nodeId` 和 `output` 必须来自实际查询的节点与输出端口。工具每次执行时读取激活画布上的当前输出并验证文件，不根据历史消息、文件名或修改时间选择版本。节点不存在、输出缺失或文件不可读时直接报错，不自动改用旧文件；`idle` 不表示节点没有可用输出。

跨片段衔接需要上一段尾帧时，使用 `extractLastFrame`，直接引用上一段的原始视频节点：

```json
{ "source": { "nodeId": "原始视频节点 ID", "output": "video" } }
```

工具实际解码统计帧数，再提取编号为 `frameCount - 1` 的最后一帧，不使用时长乘帧率估算，也不从合并成片寻找边界。返回 `source`、`sourcePath`、`frameCount`、`frameIndex`、`path` 和 `mimeType`；PNG 保存到 `assets/` 内的新文件，失败或取消会清理本次图片。两遍扫描的耗时随视频帧数增长，不缓存整段视频。将返回的 `path` 用于图片节点的 `setImage`，再作为后段参考；不要用图片生成重建尾帧。

`ffmpeg` 的 `steps` 按顺序调用 fluent 方法，`operation` 指定最后执行的方法，省略时使用 `run()`。例如输出图片序列：

```json
{
  "steps": [
    { "method": "input", "args": ["assets/input.mp4"] },
    { "method": "fps", "args": [1] },
    { "method": "output", "args": ["assets/frame%03d.png"] }
  ]
}
```

也可使用 `operation: { "method": "save", "args": ["assets/output.mp4"] }`，或者原生的 `screenshots`、`concat` 等操作。查询可用编码器、编解码器、格式、滤镜时，省略 `steps`，将 `operation.method` 设为 `availableEncoders`、`availableCodecs`、`availableFormats` 或 `availableFilters`。

上述能力查询及其 `getAvailable*` 别名的 `operation.args` 必须为 `[]`。例如查询 `drawtext` 是否可用时，使用 `{"operation":{"method":"availableFilters","args":[]}}`，再从返回结果读取 `drawtext`，不要把名称作为查询参数。宿主会拒绝多余参数并返回工具错误；回调由宿主注入。`ffprobe` 仍支持原生输入索引和选项数组。

`options` 对应宿主支持的 fluent 构造选项：`source`、`cwd`、`niceness`、`priority`、`stdoutLines`、`timeout`。`steps` 支持宿主已有的全部配置方法和别名；除输入节点引用外，`args` 中的 JSON 值保持原样，`undefinedArgs` 可指定要传入 `undefined` 的位置。

`options.source` 及 `input`、`addInput`、`mergeAdd` 的首个参数也支持 `{ "nodeId": "实际节点 ID", "output": "video" }`。例如合并两段视频时，分别引用两个节点的 `video` 输出，再按实际流信息配置合并滤镜；执行时由工具解析真实路径，字符串路径的原有用法继续支持。

## 原生能力与执行

- 不另设 FFmpeg 参数白名单，不拆分或重写 `inputOptions`、`outputOptions`、滤镜参数。
- 不限制为单文件输出，图片序列、HLS/DASH 分片、多输入多输出均按原生方式处理。
- 不重定向到临时文件，不强制设置执行时长。输出目录按原生要求准备，已有文件的覆盖遵循 FFmpeg 原生规则；未要求覆盖时应使用新文件名。
- 保留宿主已有的显式工作区路径检查、缺少 FFmpeg 时的安装提示、错误传播和转换取消。取消或失败可能留下原生处理产生的部分文件，工具不自动删除素材。

此工具传递 JSON 调用数据，不接收 JavaScript、回调或 Node 流；可执行文件由插件市场配置。宿主只检查显式文件入口，原始参数、滤镜和媒体清单中的间接访问不是文件系统沙箱。FFprobe 和能力查询的原生接口不暴露子进程，取消会停止等待，底层查询自行退出。
