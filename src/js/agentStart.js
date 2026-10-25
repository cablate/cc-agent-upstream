export const canStartAgent=d=>!!d&&(['stopped','error'].includes(d.phase)||!d.connected&&!['starting','busy','handing-off'].includes(d.phase));
export const agentStarting=d=>!!d&&['starting','handing-off'].includes(d.phase);
