// CLI argument parsing (kept importable for tests).
export function parseArgs(argv) {
  const opts = { yolo: false, resume: null, resumeList: false, continueLast: false, prompt: null, model: null, print: false, help: false, version: false, command: null, outputFormat: null, outputSchema: null, maxTurns: null, background: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yolo' || a === '-y') opts.yolo = true;
    else if (a === '--continue' || a === '-c') opts.continueLast = true;
    else if (a === '--resume' || a === '-r') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) opts.resume = argv[++i];
      else opts.resumeList = true;
    } else if (a === '--model' || a === '-m') opts.model = argv[++i];
    else if (a === '--print' || a === '-p') opts.print = true;
    else if (a === '--output-format') opts.outputFormat = argv[++i];
    else if (a.startsWith('--output-format=')) opts.outputFormat = a.split('=')[1];
    else if (a === '--output-schema') opts.outputSchema = argv[++i];
    else if (a.startsWith('--output-schema=')) opts.outputSchema = a.split('=').slice(1).join('=');
    else if (a === '--max-turns') opts.maxTurns = Number(argv[++i]);
    else if (a === '--background') opts.background = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else rest.push(a);
  }
  // first bare word is a subcommand when it is one of the known verbs
  if (rest.length && ['setup', 'doctor'].includes(rest[0])) {
    opts.command = rest.shift();
  }
  opts.prompt = rest.join(' ');
  return opts;
}
