// system-reminder injection helpers.

export function reminderBlock(text) {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

// Injected at the start of every user turn.
export function dateReminder(now = new Date()) {
  return reminderBlock(`The current date is ${now.toISOString().slice(0, 10)}.`);
}

// Reflects current todo state so the model sees it without re-calling TodoWrite.
export function todoReminder(todos) {
  if (!todos?.length) return '';
  const lines = todos.map((t) => `- [${t.status}] ${t.content}`);
  return reminderBlock(`Here is the current todo list (maintained via the TodoWrite tool):\n${lines.join('\n')}`);
}

