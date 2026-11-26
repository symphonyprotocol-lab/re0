import type { Shape } from '@/i18n/format';

/** `/oauth/consent/[id]` (an MCP client asks to connect to the account) and `/oauth/error`. */
export const zh = {
  title: '授权应用连接 re0',
  eyebrow: 'MCP 连接授权',
  heading: '「{client}」请求连接你的 re0 账户',
  lede: '批准后，这个应用可以通过 MCP 以你的身份使用 re0，权限以你在下面的选择为准。你可以随时在「设置 → API → 已连接的应用」里断开它。',
  signedInAs: '当前账户',
  client: {
    label: '应用',
    verified: '身份由 {host} 上的元数据文件确认',
    registered: '自行注册的应用，名称由它自己填写，re0 无法核实',
    website: '网站',
    redirect: '批准后返回到',
    loopback: '这个应用会把你送回本机地址（{host}）。只有在你刚在这台电脑上的工具里发起连接时才批准，因为本机上的任何程序都可以监听这个地址。',
  },
  permissions: {
    title: '授予的权限',
    kind: '连接类型',
    kinds: { account: '账户', workspace: '仅工作区' },
    kindHints: { account: '搜索、查看和向 Ree 提问；可选允许修改和工作区', workspace: '只能读写工作区里的一个目录' },
    writeHint: '可以发帖、追问、创建和删除 Ree、管理知识库与评论。不开启时只能搜索、查看和提问。',
    rootHint: '应用只能看到这个目录及其子目录，并把它当作「/」。目录外的路径一律返回「不存在」。',
    workspaceOnlyHint: '仅工作区的连接不能提问、发帖或管理 Ree；万一泄露，也只会影响这一个目录。',
    spendNote: '通过它提问、发帖、追问和添加知识与网页上一样扣除 credits。',
  },
  approve: '批准连接',
  deny: '拒绝',
  redirecting: '正在返回应用…',
  errors: {
    expired: '这个授权请求已失效：已经处理过、超过 30 分钟，或是在另一个浏览器里发起的。请回到应用重新连接。',
    invalid_permissions: '请选择这个应用对工作区的权限；根目录必须是有效路径。',
    too_many_apps: '最多可同时连接 50 个应用，请先在「设置 → API」断开不用的应用。',
  },
  error: {
    title: '无法完成连接',
    invalid_client: '这个应用没有在 re0 注册，或者无法读取它的元数据文件。请回到应用重新连接；如果问题持续，请联系应用的开发者。',
    invalid_redirect_uri: '应用给出的返回地址与它登记的不一致。为了你的安全，re0 不会跳转到未登记的地址。',
    unknown: '授权请求无效。请回到应用重新连接。',
    back: '返回 re0',
  },
};

export const en: Shape<typeof zh> = {
  title: 'Authorize an app to connect to re0',
  eyebrow: 'MCP connection',
  heading: '“{client}” wants to connect to your re0 account',
  lede: 'Once approved, this app can use re0 as you through MCP, with the permissions you choose below. You can disconnect it at any time under Settings → API → Connected apps.',
  signedInAs: 'Signed in as',
  client: {
    label: 'App',
    verified: 'Identity confirmed by its metadata document on {host}',
    registered: 'A self-registered app: it chose its own name, which re0 cannot verify',
    website: 'Website',
    redirect: 'Returns you to',
    loopback: 'This app sends you back to an address on this computer ({host}). Approve only if you just started connecting from a tool on this computer: any program on it could be listening there.',
  },
  permissions: {
    title: 'Permissions',
    kind: 'Connection type',
    kinds: { account: 'Account', workspace: 'Workspace only' },
    kindHints: { account: 'Search, read and ask Rees; optionally make changes and use the workspace', workspace: 'Only reads and writes one workspace folder' },
    writeHint: 'Post, follow up, create and delete Rees, manage knowledge and comments. Without it, the app can only search, read and ask.',
    rootHint: 'The app sees only this folder and what is inside it, as its “/”. Any path outside it is “not found”.',
    workspaceOnlyHint: 'A workspace-only connection cannot ask, post or manage Rees; if it leaks, only this folder is exposed.',
    spendNote: 'Asking, posting, following up and adding knowledge through it spend credits exactly as on the web.',
  },
  approve: 'Approve',
  deny: 'Deny',
  redirecting: 'Returning to the app…',
  errors: {
    expired: 'This authorization request is no longer valid: it was already handled, is more than 30 minutes old, or was started in another browser. Go back to the app and connect again.',
    invalid_permissions: 'Choose what this app may do with the workspace; the root folder must be a valid path.',
    too_many_apps: 'You can keep up to 50 connected apps. Disconnect one you no longer use under Settings → API first.',
  },
  error: {
    title: 'Could not connect',
    invalid_client: 'This app is not registered with re0, or its metadata document could not be read. Go back to the app and connect again; if it keeps happening, contact the app’s developer.',
    invalid_redirect_uri: 'The address the app asked to return to does not match the ones it registered. For your safety, re0 does not redirect to an unregistered address.',
    unknown: 'The authorization request is not valid. Go back to the app and connect again.',
    back: 'Back to re0',
  },
};
