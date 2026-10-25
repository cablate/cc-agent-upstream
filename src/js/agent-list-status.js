export function agentListStatus(agent, activity = '', isAdmin = false) {
  if (agent.phase === 'error') return 'error';
  if (isAdmin && agent.terminalPrompt) return 'waiting';
  if (activity || (agent.connected && (agent.phase === 'busy' || agent.background > 0))) return 'busy';
  if (agent.phase === 'stopped') return 'paused';
  return agent.connected ? 'online' : 'offline';
}

export function agentListPreview(agent) {
  return agent.phase === 'error' ? agent.lastError || '' : '';
}
