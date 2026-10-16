import { Router } from "express";
import { z } from "zod";
import { imageGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  canvasId: imageGenerationSchema.shape.outputDirectory.unwrap(),
  mediaType: z.enum(["image", "video", "audio"]),
  outputDirectory: imageGenerationSchema.shape.outputDirectory.unwrap(),
  id: z.uuid().optional(),
}), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  res.set("Cache-Control", "no-store").json(success(await u.mediaTasks.getMediaTask({ ...req.body, directory })));
});
