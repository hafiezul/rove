// Stands in for pi-agent-core's Agent, loaded by a process that drives Pi's SDK itself.
export class Agent {
  constructor() {
    this.listeners = [];
    this.state = { tools: [], model: { provider: "test", id: "runner-model" } };
  }
  subscribe(listener) {
    this.listeners.push(listener);
    return () => undefined;
  }
  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
  async runWithLifecycle(executor) {
    await executor();
  }
}
