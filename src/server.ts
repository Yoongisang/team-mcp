#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import "./config.js";
import { getTeamRulesTool, getTeamRules } from "./tools/get-team-rules.js";
import { showProgressTool, showProgress } from "./tools/show-progress.js";
import { createPlanTool, createPlan } from "./tools/create-plan.js";
import { completeTaskTool, completeTask } from "./tools/complete-task.js";
import { changeDirectionTool, changeDirection } from "./tools/change-direction.js";
import { updatePlanTool, updatePlan } from "./tools/update-plan.js";
import { prepareMeetingTool, prepareMeeting } from "./tools/prepare-meeting.js";
import { finishMeetingTool, finishMeeting } from "./tools/finish-meeting.js";
import {
  applyMeetingToBacklogTool,
  applyMeetingToBacklog,
} from "./tools/apply-meeting-to-backlog.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const handlers: Record<string, { tool: Tool; handler: Handler }> = {
  [getTeamRulesTool.name]: { tool: getTeamRulesTool, handler: getTeamRules },
  [showProgressTool.name]: { tool: showProgressTool, handler: showProgress },
  [createPlanTool.name]: { tool: createPlanTool, handler: createPlan },
  [completeTaskTool.name]: { tool: completeTaskTool, handler: completeTask },
  [changeDirectionTool.name]: { tool: changeDirectionTool, handler: changeDirection },
  [updatePlanTool.name]: { tool: updatePlanTool, handler: updatePlan },
  [prepareMeetingTool.name]: { tool: prepareMeetingTool, handler: prepareMeeting },
  [finishMeetingTool.name]: { tool: finishMeetingTool, handler: finishMeeting },
  [applyMeetingToBacklogTool.name]: {
    tool: applyMeetingToBacklogTool,
    handler: applyMeetingToBacklog,
  },
};

const TOOLS: Tool[] = Object.values(handlers).map((h) => h.tool);

const server = new Server(
  { name: "team-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const entry = handlers[req.params.name];
  if (!entry) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }
  try {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    return await entry.handler(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[team-mcp] server ready");
}

main().catch((err) => {
  console.error("[team-mcp] fatal:", err);
  process.exit(1);
});
