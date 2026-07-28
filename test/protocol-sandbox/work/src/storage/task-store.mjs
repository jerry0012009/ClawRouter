export class TaskStore {
  constructor(tasks = []) {
    this.tasks = tasks;
  }

  all() {
    return [...this.tasks];
  }
}
