// The tools in the order tools/list shows them, and tools/call with its result-size backstop.
import { maxResultCharacters, resultSize } from '../paging.mjs';
import { RpcError, ToolError, isObject, text } from './common.mjs';
import { graphDiff } from './diff.mjs';
import { contextFor, graphList, graphPublish, graphRead, graphSchema } from './graphs.mjs';
import { latentRead, latentTeam, latentTransfer } from './latent.mjs';
import { roomList, roomOpen, roomRead } from './rooms.mjs';
import { sessionRead, sessionSearch } from './sessions.mjs';

// Rooms are opened and read here; their proposals are settled only by people in the browser.
export const tools = new Map([
  sessionSearch,
  sessionRead,
  graphSchema,
  graphPublish,
  graphRead,
  contextFor,
  roomOpen,
  roomRead,
  latentRead,
  latentTransfer,
  latentTeam,
  graphList,
  roomList,
  graphDiff,
]);

export const toolList = [...tools].map(([name, { description, inputSchema }]) => ({ name, description, inputSchema }));

export async function callTool(params) {
  if (typeof params.name !== 'string') throw new RpcError(-32602, 'tools/call requires a tool name.');
  const tool = tools.get(params.name);
  if (!tool) {
    throw new RpcError(-32602, /^[\w-]{1,64}$/.test(params.name) ? `Unknown tool: ${params.name}.` : 'Unknown tool.');
  }
  const args = params.arguments ?? {};
  try {
    if (!isObject(args)) throw new ToolError('Tool arguments must be a JSON object.');
    const result = await tool.run(args);
    // Backstop: paging keeps every result under the bound, so this never fires unless
    // there is a bug. An oversized result is withheld rather than cut by the client.
    const size = result.content.reduce((sum, item) => sum + resultSize(item.text), 0);
    if (size > maxResultCharacters) {
      console.error(`context-ledger mcp: ${params.name} result of ${size} characters withheld.`);
      return { content: [text('The result was larger than this server\'s 40,000-character bound and was withheld. ' +
        'This is a Context Ledger bug.')], isError: true };
    }
    return result;
  } catch (error) {
    if (!(error instanceof ToolError)) console.error(`context-ledger mcp: ${params.name} failed:`, error);
    const message = error instanceof ToolError ? error.message : 'Tool call failed.';
    return { content: [text(message)], isError: true };
  }
}
