/**
 * The workspace's MCP resources (docs/design/agent-workspace-p4.md §3;
 * lib/services/workspace-resources.ts does the work): `resources/list`,
 * `resources/templates/list`, `resources/read` and `completion/complete` for
 * `re0://ws/{+path}`, on the servers of keys that reach the workspace.
 *
 * They are set on the protocol server itself rather than through
 * `registerResource`: the SDK's resource helpers answer `resources/list` in
 * one page whatever the cursor, and call a template's completer without the
 * request's context -- so without knowing whose key asks, or which folder it
 * is limited to. Here every request resolves the caller's scope first, as a
 * `ws_*` tool does, and counts against the same `workspaceRead` limit.
 *
 * No `subscribe` and no `listChanged` (§3.3): the server is stateless, and
 * nothing would tell one instance what another changed.
 *
 * CONSTRAINT: a server these handlers are set on must never also call
 * `registerResource`, nor register a prompt or template with a completer.
 * The SDK then sets `resources/*` or `completion/complete` itself, finds the
 * handler already there and throws while the server is built -- which takes
 * MCP down for every key that reaches the workspace. Add new resources here
 * instead. tests/integration/workspace-resources.test.ts pins this.
 */
import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError, type ServerContext } from '@modelcontextprotocol/server';
import { McpToolError } from '@/lib/services/mcp';
import { WorkspaceError } from '@/lib/services/workspace';
import { completePaths, listResources, readResource, RESOURCE_NOTE, RESOURCE_TEMPLATE } from '@/lib/services/workspace-resources';
import { callerOf, keyLimit, scopeOf } from '@/lib/http/mcp-workspace';

type Server = Parameters<Parameters<typeof import('mcp-handler').createMcpHandler>[0]>[0];

/** The caller's scope, after the read limit; a refusal or a failure as the protocol error a client understands. */
async function asResource<T>(ctx: ServerContext, uri: string | null, work: (scope: Awaited<ReturnType<typeof scopeOf>>) => Promise<T>): Promise<T> {
  try {
    const caller = callerOf(ctx);
    await keyLimit('workspaceRead', caller);
    return await work(await scopeOf(caller));
  } catch (error) {
    if (error instanceof WorkspaceError) {
      if (uri !== null && (error.code === 'not_found' || error.code === 'invalid_path')) throw new ResourceNotFoundError(uri, error.message);
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message, { error: error.code, ...error.details });
    }
    if (error instanceof McpToolError) throw new ProtocolError(ProtocolErrorCode.InvalidRequest, error.message, { error: error.code, ...error.details });
    if (error instanceof ProtocolError) throw error;
    console.warn(`mcp workspace resource failed: ${error instanceof Error ? error.message : 'unknown'}`);
    throw new ProtocolError(ProtocolErrorCode.InternalError, 'Something went wrong on re0. Try again.');
  }
}

export function registerWorkspaceResources(server: Server): void {
  const protocol = server.server;
  protocol.registerCapabilities({ resources: { subscribe: false, listChanged: false }, completions: {} });

  protocol.setRequestHandler('resources/list', (request, ctx) => asResource(ctx, null, (scope) => listResources(scope, request.params?.cursor)));

  protocol.setRequestHandler('resources/templates/list', async () => ({
    resourceTemplates: [
      {
        uriTemplate: RESOURCE_TEMPLATE,
        name: 'workspace-file',
        title: 'Workspace file',
        description: `${RESOURCE_NOTE} Named by its path (the path ws_list and ws_read show, without the leading slash). Text up to 1 MB and PNG, JPEG, GIF or WebP images up to 1 MB are returned whole; resources/list offers only those, most recently changed first, as a snapshot (a file changed while you page shows on the next listing).`,
      },
    ],
  }));

  protocol.setRequestHandler('resources/read', (request, ctx) => asResource(ctx, request.params.uri, async (scope) => ({ contents: [await readResource(scope, request.params.uri)] })));

  protocol.setRequestHandler('completion/complete', async (request, ctx) => {
    const { ref, argument } = request.params;
    if (ref.type !== 'ref/resource' || ref.uri !== RESOURCE_TEMPLATE || argument.name !== 'path') return { completion: { values: [], hasMore: false } };
    return asResource(ctx, null, async (scope) => {
      const { values, hasMore } = await completePaths(scope, argument.value);
      return { completion: { values, hasMore } };
    });
  });
}
