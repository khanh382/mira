/**
 * Hook events kế thừa từ OpenClaw, chia thành 2 nhóm:
 *
 * 1. Internal Hooks - fire-and-forget, chạy song song
 * 2. Plugin Hooks  - có priority, chạy tuần tự, có thể modify data
 *
 * Naming convention: <domain>.<action>
 */

// ─── Internal Hook Events (event-driven, fire-and-forget) ───────────────

export enum InternalHookEvent {
  // Message lifecycle
  MESSAGE_RECEIVED = 'message.received',
  MESSAGE_TRANSCRIBED = 'message.transcribed',
  MESSAGE_PREPROCESSED = 'message.preprocessed',
  MESSAGE_SENT = 'message.sent',

  // Command triggers
  COMMAND_NEW = 'command.new',
  COMMAND_RESET = 'command.reset',
  COMMAND_STOP = 'command.stop',

  // Agent lifecycle
  AGENT_BOOTSTRAP = 'agent.bootstrap',

  // Gateway lifecycle
  GATEWAY_STARTUP = 'gateway.startup',
  GATEWAY_SHUTDOWN = 'gateway.shutdown',

  // Session lifecycle
  SESSION_COMPACT_BEFORE = 'session.compact.before',
  SESSION_COMPACT_AFTER = 'session.compact.after',
}

// ─── Plugin Hook Names (modifying, priority-ordered, sequential) ────────

export enum PluginHookName {
  // Agent pipeline hooks
  BEFORE_MODEL_RESOLVE = 'before_model_resolve',
  BEFORE_PROMPT_BUILD = 'before_prompt_build',
  BEFORE_AGENT_START = 'before_agent_start',
  LLM_INPUT = 'llm_input',
  LLM_OUTPUT = 'llm_output',
  AGENT_END = 'agent_end',
  BEFORE_COMPACTION = 'before_compaction',
  AFTER_COMPACTION = 'after_compaction',
  BEFORE_RESET = 'before_reset',

  // Message hooks
  MESSAGE_RECEIVED = 'message_received',
  MESSAGE_SENDING = 'message_sending',
  MESSAGE_SENT = 'message_sent',

  // Tool/Skill hooks
  BEFORE_TOOL_CALL = 'before_tool_call',
  AFTER_TOOL_CALL = 'after_tool_call',
  TOOL_RESULT_PERSIST = 'tool_result_persist',

  // Message persistence
  BEFORE_MESSAGE_WRITE = 'before_message_write',

  // Session hooks
  SESSION_START = 'session_start',
  SESSION_END = 'session_end',

  // Sub-agent hooks
  SUBAGENT_SPAWNING = 'subagent_spawning',
  SUBAGENT_SPAWNED = 'subagent_spawned',
  SUBAGENT_ENDED = 'subagent_ended',
}
