/**
 * Grammar of the human-facing `/flowus` command.
 *
 * Parsing is deliberately total and pure: the handler renders exactly one
 * result from the parsed intent, and every unrecognized shape yields `help`
 * with the usage text rather than throwing.
 *
 * @module dsh-flowus/command-grammar
 */

/** Usage text shared by every help-shaped outcome. */
export const USAGE = [
  'Usage: /flowus [status|login|logout|tools|call <tool> [jsonArgs]|reload|help]',
  '',
  '  status            show authorization and tool-sync state',
  '  login             open the FlowUs authorization page in your browser',
  '  logout            delete the stored FlowUs credentials',
  '  tools             list the FlowUs tools currently visible to the model',
  '  call <tool> [json]  call one FlowUs tool directly (tools list names)',
  '  reload            reconnect and re-sync the FlowUs tool list',
  '  help              this text',
].join('\n');

/** Intent kinds owned by `/flowus`. */
export const FLOWUS_COMMAND_KINDS = Object.freeze([
  'status',
  'login',
  'logout',
  'tools',
  'call',
  'reload',
  'help',
]);

/**
 * Split one invocation's verbatim trailing input into a command intent.
 * @param rawInput - the exact text following `/flowus` (separator whitespace included).
 * @returns a closed intent object; `help` carries an optional reason.
 */
export function parseFlowusCommand(rawInput) {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (input.length === 0) return { kind: 'status' };
  const [verb, ...rest] = input.split(/\s+/u);
  const control = verb.toLowerCase();
  const tail = rest.join(' ');
  switch (control) {
    case 'status':
      return tail.length === 0 ? { kind: 'status' } : { kind: 'help', reason: 'status takes no arguments' };
    case 'login':
    case 'auth':
      return tail.length === 0 ? { kind: 'login' } : { kind: 'help', reason: 'login takes no arguments' };
    case 'logout':
    case 'signout':
      return tail.length === 0 ? { kind: 'logout' } : { kind: 'help', reason: 'logout takes no arguments' };
    case 'tools':
      return tail.length === 0 ? { kind: 'tools' } : { kind: 'help', reason: 'tools takes no arguments' };
    case 'reload':
    case 'refresh':
      return tail.length === 0 ? { kind: 'reload' } : { kind: 'help', reason: 'reload takes no arguments' };
    case 'help':
      return { kind: 'help' };
    case 'call': {
      if (rest.length === 0) return { kind: 'help', reason: 'call needs a tool name' };
      const [tool, ...jsonParts] = rest;
      const json = jsonParts.join(' ').trim();
      if (json.length === 0) return { kind: 'call', tool, args: {} };
      try {
        const parsed = JSON.parse(json);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { kind: 'help', reason: 'call arguments must be a JSON object' };
        }
        return { kind: 'call', tool, args: parsed };
      } catch {
        return { kind: 'help', reason: 'call arguments are not valid JSON' };
      }
    }
    default:
      return { kind: 'help', reason: `unknown subcommand ${JSON.stringify(verb)}` };
  }
}
