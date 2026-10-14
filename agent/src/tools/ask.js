// AskUserQuestion tool: collect structured answers from the user via the terminal.
export const AskUserQuestionTool = {
  name: 'AskUserQuestion',
  description: `Ask the user structured multiple-choice questions when the right next step depends on information only the user has — ambiguous requirements, a choice between approaches, missing constraints.

Use it sparingly: exhaust what you can find out from the code and docs first. When several questions block you, ask them together (up to 4) rather than one at a time. Each question needs 2-4 concrete options with a short label and a one-line description; do not add a catch-all "other" option — the user can always answer freely at the prompt. multiSelect is for genuinely independent choices, not "pick one of these alternatives".
Failure modes: asking about something the repository already answers wastes the user's patience — search the code first. Vague options produce vague answers; make each option describe a different, actionable path.`,
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            header: { type: 'string', description: 'Short label (<= 12 chars) for the question chip' },
            multiSelect: { type: 'boolean' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label', 'description'],
              },
            },
          },
          required: ['question', 'header', 'multiSelect', 'options'],
        },
      },
    },
    required: ['questions'],
  },
  async execute(input, ctx) {
    const answers = await ctx.ui.askQuestions(input.questions);
    return { ok: true, output: JSON.stringify(answers, null, 2) };
  },
};
