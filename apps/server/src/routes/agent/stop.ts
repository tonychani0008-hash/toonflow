import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  requestId: z.uuid(),
}), async (req, res) => {
  const { directory, requestId } = req.body as { directory: string; requestId: string };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  await u.agent.stopAgentRequest(cwd, requestId);
  res.set("Cache-Control", "no-store").json(success());
});
