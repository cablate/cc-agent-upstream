export function agentListStatus(agent, activity = '') {
  if (agent.phase === 'error') return 'error';
  if (agent.terminalPrompt) return 'waiting';
  if (agent.connected && (agent.phase === 'busy' || agent.background > 0 || activity)) return 'busy';
  if (agent.phase === 'stopped') return 'paused';
  return agent.connected ? 'online' : 'offline';
}

export function agentListPreview(agent) {
  return agent.phase === 'error' ? agent.lastError || '' : '';
}
