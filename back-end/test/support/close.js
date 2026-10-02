/** A person closes the report (received → in_review → closed) through the store, so a new episode may report the same charge. */
export async function close(store, protocol) {
  for (const [from, to] of [['received', 'in_review'], ['in_review', 'closed']])
    await store.transitionHandoff({ protocol, from, to, now: Date.now(), agentSessionRef: 'unit00000000', emailId: crypto.randomUUID() });
}
