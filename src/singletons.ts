import type { SessionManager } from "./session-manager";

export let sessionManager: SessionManager | null = null;

/** Replace the shared SessionManager reference used by tools/commands. */
export function setSessionManager(sm: SessionManager | null): void {
  sessionManager = sm;
}

import type { PipelineManager } from "./pipeline-manager";

export let pipelineManager: PipelineManager | null = null;

/** Replace the shared PipelineManager reference used by the agent_pipeline tool. */
export function setPipelineManager(pm: PipelineManager | null): void {
  pipelineManager = pm;
}
