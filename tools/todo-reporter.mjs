// A node:test reporter for tools/node-test.mjs `--no-todo`: writes one JSON line per test result marked todo (passing
// or failing, at any nesting), from the runner's own events. Node counts a failing todo test as a successful run, so
// the wrapper reads this file after the run and fails it if any line is here.
export default async function* todoReporter(source) {
  for await (const event of source) {
    if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.todo !== undefined && event.data.todo !== false) {
      yield `${JSON.stringify({ name: event.data.name, file: event.data.file ?? null, failed: event.type === 'test:fail' })}\n`;
    }
  }
}
