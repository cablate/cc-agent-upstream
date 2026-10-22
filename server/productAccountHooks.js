// What this product does with an account's own things when the account changes: the account code (controllers/authController.js,
// services/userLifecycle.js) calls these and is otherwise generic;
// a product without agents gives empty ones. Here they are CC Agent's agents.
//
// Each is called inside the caller's own error handling, so a failure here is
// logged by the caller and never stops the account change itself.

const agents = () => require('./agentStore');

module.exports = {
  // An admin made a member: a member keeps no full-access agent.
  onDemoted(userId) { return agents().clearFullAccessFor(userId); },
  // An account read back as disabled or deleted: everything of its own that runs
  // stops. Returns {stopped: ids, failed: [{id, title}]}: the audit lines, and the
  // agents the admin is told to stop by hand.
  onAccountOff(userId) { return agents().stopAgentsOf(userId); },
  // An account deleted for good: its agents' conversations, attachments, workspaces
  // and transcripts go with it.
  onPurge(userId) { return agents().purgeOwner(userId); },
  // What would still run for an account (services/userLifecycle.js shows it before a
  // disable or delete).
  lifecycleInventory() { return agents().lifecycleInventory(); },
};
