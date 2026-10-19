/**
 * Browser half of `@blksword/dsh-flowus`: the Settings → FlowUs page.
 *
 * The host serves built client bundles, so this file is authored directly in
 * the shim format the shell's module loader consumes — one
 * `window.__ModuleLoader__.load({ id, factory })` registration whose factory
 * receives the shell's `require`. There is no build step and no bundler:
 * `react`, `react/jsx-runtime` and `@deepseek-ai/dsh-client-ui-primitives`
 * come from the shell's frozen platform module table, everything else this
 * page needs is the host's own JSON API over `fetch`.
 *
 * The page is contributed into the `settings.section` slot, which the settings
 * shell renders as one page in the settings navigation. All copy comes from
 * this plugin's dictionary (`settings.flowus`); all state comes from
 * `GET /flowus/api/status`, and every button posts to a sibling route that
 * answers with the same snapshot, so one render path covers every action.
 */

window.__ModuleLoader__.load({
  id: '@blksword/dsh-flowus',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;
    const Fragment = jsxRuntime.Fragment;
    const Button = primitives.Button;
    const Input = primitives.Input;
    const Tag = primitives.Tag;
    const StateDot = primitives.StateDot;

    /** Dictionary namespace owned by this plugin's settings page. */
    const NS = 'settings.flowus';

    /** Route prefix the host plugin serves behind the connection trust fence. */
    const API_PREFIX = '/flowus/api';

    /** How often the page re-reads status while a browser login is running. */
    const LOGIN_POLL_MS = 1500;

    const en = {
      nav: 'FlowUs',
      title: 'FlowUs',
      description: 'Official FlowUs MCP server: authorize once in your browser, then let the agent read and write your workspace.',
      loading: 'Reading FlowUs state…',
      unauthorized: 'Not authorized',
      unauthorizedDetail: 'Click “Sign in with FlowUs”, then approve the request in the browser tab that opens.',
      authorized: 'Authorized',
      authorizedDetail: 'The browser authorization is stored and refreshable.',
      authorizedNotConnected: 'Authorized, not connected',
      authorizedNotConnectedDetail: 'The stored authorization is fine, but no MCP session is open. Use Reconnect; if that keeps failing, sign in again.',
      loginPendingShort: 'Waiting for the browser…',
      loginPending: 'A browser tab was opened for the FlowUs authorization. Approve the request there; this page updates by itself.',
      loginWaiting: 'Waiting {time}',
      loginFailed: 'Authorization failed',
      connected: 'Connected',
      connectedDetail: 'Tools are published to the model.',
      signIn: 'Sign in with FlowUs',
      signInAgain: 'Re-authorize',
      cancelLogin: 'Cancel',
      reload: 'Reconnect',
      reloadHint: 'Open a fresh MCP session and re-sync the tool list.',
      logout: 'Sign out',
      logoutHint: 'Delete the stored FlowUs credentials. The FlowUs tools go offline until you sign in again.',
      refresh: 'Refresh',
      server: 'MCP endpoint',
      namespace: 'Tool namespace',
      stateFile: 'Credential file',
      scope: 'Scope',
      expires: 'Expires',
      expiresNever: 'no expiry reported',
      refreshToken: 'Refresh token',
      version: 'Server version',
      yes: 'yes',
      no: 'no',
      tools: 'Tools',
      toolsCount: '{count} tool(s) published',
      toolsFiltered: '{shown} of {total} shown',
      toolsSearch: 'Search tools by name or description',
      toolsNoMatch: 'No tool matches “{query}”.',
      noTools: 'No tools are published yet. Authorize, then use Reconnect.',
      readOnly: 'read-only',
      write: 'write',
      copy: 'Copy',
      copied: 'Copied',
      copyStatePath: 'Copy the credential file path',
      copyLoginUrl: 'Copy the authorization URL',
      lastSync: 'Last sync',
      lastError: 'Last error',
      retryingAutomatically: 'the server is temporarily unavailable, so the plugin retries automatically',
      busy: 'Working…',
      retry: 'Retry',
      unknownError: 'Unknown error',
      timeNow: 'just now',
      timeMinutes: '{count} min ago',
      timeHours: '{count} h ago',
      timeDays: '{count} d ago',
    };

    const zh = {
      nav: 'FlowUs',
      title: 'FlowUs',
      description: '连接 FlowUs 官方 MCP 服务器：在浏览器里授权一次，之后就可以让 Agent 直接读写你的空间。',
      loading: '正在读取 FlowUs 状态…',
      unauthorized: '未授权',
      unauthorizedDetail: '点击「登录 FlowUs」，在打开的浏览器页面里确认授权即可。',
      authorized: '已授权',
      authorizedDetail: '浏览器授权凭据已保存，可自动续期。',
      authorizedNotConnected: '已授权，但未连接',
      authorizedNotConnectedDetail: '凭据本身没问题，只是当前没有处于连接的 MCP 会话。可点「重新连接」；若持续失败，请重新授权。',
      loginPendingShort: '等待浏览器授权…',
      loginPending: '已打开 FlowUs 授权页面，请在浏览器中确认；本页面会自动刷新。',
      loginWaiting: '已等待 {time}',
      loginFailed: '授权失败',
      connected: '已连接',
      connectedDetail: '工具已注册给模型使用。',
      signIn: '登录 FlowUs',
      signInAgain: '重新授权',
      cancelLogin: '取消',
      reload: '重新连接',
      reloadHint: '重新建立 MCP 会话并同步工具列表。',
      logout: '退出登录',
      logoutHint: '删除已保存的 FlowUs 凭据；在重新登录前，FlowUs 工具会下线。',
      refresh: '刷新',
      server: 'MCP 地址',
      namespace: '工具命名空间',
      stateFile: '凭据文件',
      scope: '授权范围',
      expires: '过期时间',
      expiresNever: '未提供过期时间',
      refreshToken: 'Refresh token',
      version: '服务端版本',
      yes: '有',
      no: '无',
      tools: '工具',
      toolsCount: '已注册 {count} 个工具',
      toolsFiltered: '共 {total} 个，显示 {shown} 个',
      toolsSearch: '按名称或描述搜索工具',
      toolsNoMatch: '没有工具匹配「{query}」。',
      noTools: '还没有注册任何工具。完成授权后点「重新连接」。',
      readOnly: '只读',
      write: '写入',
      copy: '复制',
      copied: '已复制',
      copyStatePath: '复制凭据文件路径',
      copyLoginUrl: '复制授权地址',
      lastSync: '上次同步',
      lastError: '最近错误',
      retryingAutomatically: '服务器暂时不可用，插件会自动重试',
      busy: '处理中…',
      retry: '重试',
      unknownError: '未知错误',
      timeNow: '刚刚',
      timeMinutes: '{count} 分钟前',
      timeHours: '{count} 小时前',
      timeDays: '{count} 天前',
    };

    /**
     * Read one host route and unwrap the snapshot envelope.
     * @param {string} path - route suffix below {@link API_PREFIX}.
     * @param {'GET' | 'POST'} method - HTTP method the route accepts.
     * @returns {Promise<object>} the status snapshot.
     */
    async function requestJson(path, method) {
      const response = await fetch(`${API_PREFIX}${path}`, {
        method,
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`${method} ${API_PREFIX}${path} failed with HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload || payload.ok !== true) {
        throw new Error((payload && payload.error) || 'the FlowUs host route reported an unknown failure');
      }
      return payload.snapshot;
    }

    const api = {
      status: () => requestJson('/status', 'GET'),
      login: () => requestJson('/login', 'POST'),
      cancelLogin: () => requestJson('/login-cancel', 'POST'),
      logout: () => requestJson('/logout', 'POST'),
      reload: () => requestJson('/reload', 'POST'),
    };

    /**
     * Filter the tool list with a whitespace-separated, AND-ed term query.
     * @param {object[]} tools
     * @param {string} query
     * @returns {object[]} the matching subset, or the input when the query is empty.
     */
    function filterTools(tools, query) {
      const terms = String(query ?? '')
        .toLowerCase()
        .split(/\s+/u)
        .filter((term) => term.length > 0);
      if (terms.length === 0) return tools;
      return tools.filter((tool) => {
        const haystack = `${tool && tool.name ? tool.name : ''} ${tool && tool.rawName ? tool.rawName : ''} ${tool && tool.description ? tool.description : ''}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }

    /**
     * Coarse "how long ago" bucket for a duration in milliseconds.
     * @param {number} ms
     * @returns {{ unit: 'now' | 'minutes' | 'hours' | 'days', count: number }}
     */
    function timeAgo(ms) {
      if (!Number.isFinite(ms) || ms < 45_000) return { unit: 'now', count: 0 };
      const minutes = Math.round(ms / 60_000);
      if (minutes < 60) return { unit: 'minutes', count: Math.max(1, minutes) };
      const hours = Math.round(minutes / 60);
      if (hours < 24) return { unit: 'hours', count: hours };
      return { unit: 'days', count: Math.round(hours / 24) };
    }

    /**
     * Render one duration through the dictionary.
     * @param {(key: string, values?: Record<string, string | number>) => string} t
     * @param {number} ms
     * @returns {string}
     */
    function describeAgo(t, ms) {
      const { unit, count } = timeAgo(ms);
      if (unit === 'now') return t('timeNow');
      if (unit === 'minutes') return t('timeMinutes', { count });
      if (unit === 'hours') return t('timeHours', { count });
      return t('timeDays', { count });
    }

    /**
     * Whether a snapshot's failure kind is one the host retries on its own.
     * @param {unknown} kind
     * @returns {boolean}
     */
    function isTransientErrorKind(kind) {
      return kind === 'gateway' || kind === 'transient';
    }

    /**
     * Project one snapshot into everything the page renders.
     *
     * Pure and string-complete: the React component only places what this
     * returns, so the page's whole presentation is testable without a DOM.
     * @param {object | undefined} snapshot - the host status snapshot.
     * @param {(key: string, values?: Record<string, string | number>) => string} t - dictionary reader.
     * @param {string} [query] - current tool filter.
     * @param {number} [now] - clock, injectable for tests.
     * @returns {object} the view model.
     */
    function statusViewModel(snapshot, t, query = '', now = Date.now()) {
      const auth = (snapshot && snapshot.authorization) || {};
      const connection = (snapshot && snapshot.connection) || {};
      const login = (snapshot && snapshot.login) || { phase: 'idle' };
      const tools = Array.isArray(snapshot && snapshot.tools) ? snapshot.tools : [];
      const search = typeof query === 'string' ? query : '';
      const shown = filterTools(tools, search);

      let badge;
      if (login.phase === 'pending') {
        badge = { dot: 'ongoing', tone: 'info', title: t('loginPendingShort'), detail: t('loginPending') };
      } else if (login.phase === 'failed') {
        badge = { dot: 'error', tone: 'danger', title: t('loginFailed'), detail: login.error || t('unknownError') };
      } else if (!auth.configured) {
        badge = { dot: 'warning', tone: 'warning', title: t('unauthorized'), detail: t('unauthorizedDetail') };
      } else if (!connection.connected) {
        badge = {
          dot: 'warning',
          tone: 'warning',
          title: t('authorizedNotConnected'),
          detail: t('authorizedNotConnectedDetail'),
        };
      } else {
        badge = {
          dot: 'done',
          tone: 'success',
          title: t('connected'),
          detail: t('connectedDetail'),
          tag: t('toolsCount', { count: connection.toolCount || 0 }),
        };
      }

      const statePath = snapshot && snapshot.server && snapshot.server.statePath ? snapshot.server.statePath : null;
      const facts = [
        { key: 'server', label: t('server'), value: (snapshot && snapshot.server && snapshot.server.url) || '—' },
        {
          key: 'namespace',
          label: t('namespace'),
          value: snapshot && snapshot.server && snapshot.server.namespace ? `${snapshot.server.namespace}*` : '—',
        },
        { key: 'stateFile', label: t('stateFile'), value: statePath || '—', copy: statePath },
        { key: 'scope', label: t('scope'), value: auth.scope || '—' },
        { key: 'expires', label: t('expires'), value: auth.expiresAt || t('expiresNever') },
        { key: 'refreshToken', label: t('refreshToken'), value: auth.hasRefreshToken ? t('yes') : t('no') },
      ];
      if (connection.serverVersion) facts.push({ key: 'version', label: t('version'), value: connection.serverVersion });
      if (connection.lastSyncAt) {
        const at = Date.parse(connection.lastSyncAt);
        facts.push({
          key: 'lastSync',
          label: t('lastSync'),
          value: Number.isFinite(at) ? `${connection.lastSyncAt} · ${describeAgo(t, now - at)}` : connection.lastSyncAt,
        });
      }

      return {
        badge,
        facts,
        tools: tools.map((tool) => ({
          name: String((tool && tool.name) || ''),
          summary: String((tool && tool.description) || '').split('\n')[0],
          readOnly: tool && tool.readOnly === true,
        })),
        toolsShown: shown.map((tool) => ({
          name: String((tool && tool.name) || ''),
          summary: String((tool && tool.description) || '').split('\n')[0],
          readOnly: tool && tool.readOnly === true,
        })),
        toolsEmpty: shown.length === 0,
        toolsTitle: `${t('tools')} (${tools.length})`,
        toolsSummary: search.length > 0 ? t('toolsFiltered', { shown: shown.length, total: tools.length }) : null,
        query: search,
        loginPhase: login.phase,
        loginUrl: login.authorizationUrl || null,
        loginElapsed: login.phase === 'pending' && typeof login.startedAt === 'number' ? describeAgo(t, now - login.startedAt) : null,
        busyHint: t('busy'),
        canSignIn: login.phase !== 'pending',
        canSignOut: auth.configured === true,
        statePath,
        error: (snapshot && snapshot.lastError) || (login.phase === 'failed' ? login.error : null) || null,
        // A gateway/transport failure is temporary: the plugin retries on its
        // own, so the page says so instead of showing a bare red line.
        errorTransient: isTransientErrorKind(snapshot && snapshot.lastErrorKind),
      };
    }

    /** Small inline style helpers so the page needs no CSS asset. */
    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '46rem' },
      header: { display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { margin: 0, fontSize: '1.05rem', fontWeight: 600 },
      description: { margin: 0, fontSize: '0.85rem', color: 'var(--dsw-alias-text-secondary, #8b8f96)' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '14px',
        border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.22))',
        borderRadius: '12px',
      },
      badgeRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      badgeTitle: { fontSize: '0.95rem', fontWeight: 600 },
      detail: { margin: 0, fontSize: '0.85rem', color: 'var(--dsw-alias-text-secondary, #8b8f96)' },
      facts: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', margin: 0, fontSize: '0.82rem' },
      factLabel: { color: 'var(--dsw-alias-text-tertiary, #8b8f96)', whiteSpace: 'nowrap' },
      factValue: { margin: 0, overflowWrap: 'anywhere', fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      pending: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px 12px',
        borderRadius: '10px',
        background: 'var(--dsw-alias-fill-tertiary, rgba(127,127,127,0.10))',
        fontSize: '0.85rem',
      },
      error: { margin: 0, fontSize: '0.82rem', color: 'var(--dsw-alias-text-danger, #c0392b)', overflowWrap: 'anywhere' },
      link: { fontSize: '0.8rem', overflowWrap: 'anywhere' },
      toolList: {
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        maxHeight: '22rem',
        overflowY: 'auto',
      },
      toolRow: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '0.82rem' },
      toolHead: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      toolName: { fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)' },
      toolSummary: { color: 'var(--dsw-alias-text-tertiary, #8b8f96)' },
      sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' },
      sectionTitle: { fontSize: '0.95rem', fontWeight: 600 },
      search: { maxWidth: '20rem' },
      muted: { fontSize: '0.78rem', color: 'var(--dsw-alias-text-tertiary, #8b8f96)' },
      copyRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      busy: { fontSize: '0.8rem', color: 'var(--dsw-alias-text-tertiary, #8b8f96)' },
    };

    /**
     * Render the Settings → FlowUs page.
     * @param {object} props - framework props; `t` comes from the `settings.flowus` dictionary.
     * @returns {object} the React element tree.
     */
    function FlowusSettingsPage(props) {
      const t = props.t || ((key) => key);
      const [state, setState] = react.useState({ phase: 'loading', snapshot: undefined, error: undefined, query: '', copied: undefined });
      const [busy, setBusy] = react.useState(undefined);
      const query = typeof state.query === 'string' ? state.query : '';

      const refresh = react.useCallback(async () => {
        try {
          const snapshot = await api.status();
          setState((previous) => ({ ...previous, phase: 'ready', snapshot, error: undefined }));
        } catch (error) {
          setState((previous) => ({
            ...previous,
            phase: previous.snapshot ? 'ready' : 'failed',
            error: (error && error.message) || String(error),
          }));
        }
      }, []);

      react.useEffect(() => {
        void refresh();
        // Returning to the tab refreshes immediately instead of waiting for the
        // next poll; a hidden tab does no polling work at all.
        if (typeof document === 'undefined') return undefined;
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void refresh();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
      }, [refresh]);

      const phase = state.snapshot && state.snapshot.login ? state.snapshot.login.phase : 'idle';
      react.useEffect(() => {
        if (phase !== 'pending') return undefined;
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          void refresh();
        }, LOGIN_POLL_MS);
        return () => clearInterval(timer);
      }, [phase, refresh]);

      const run = react.useCallback(
        (action) => async () => {
          setBusy(action);
          try {
            const snapshot = await api[action]();
            setState((previous) => ({ ...previous, phase: 'ready', snapshot, error: undefined }));
          } catch (error) {
            setState((previous) => ({ ...previous, error: (error && error.message) || String(error) }));
          } finally {
            setBusy(undefined);
          }
        },
        [],
      );

      /** Copy one value and show transient feedback; a blocked clipboard is not an error. */
      const copy = react.useCallback(async (label, value) => {
        if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return;
        try {
          await navigator.clipboard.writeText(value);
          setState((previous) => ({ ...previous, copied: label }));
        } catch {
          /* the value stays on screen; nothing to recover */
        }
      }, []);

      if (state.phase === 'loading') {
        return jsx('div', { style: styles.root, children: jsx('p', { style: styles.detail, children: t('loading') }) });
      }

      const model = statusViewModel(state.snapshot, t, query);
      const copied = typeof state.copied === 'string' ? state.copied : undefined;
      const children = [
        jsxs('header', {
          key: 'header',
          style: styles.header,
          children: [
            jsx('h2', { key: 'title', style: styles.title, children: t('title') }),
            jsx('p', { key: 'description', style: styles.description, children: t('description') }),
          ],
        }),
        jsxs('section', {
          key: 'status',
          style: styles.card,
          children: [
            jsxs('div', {
              key: 'badge',
              style: styles.badgeRow,
              children: [
                jsx(StateDot, { state: model.badge.dot }),
                jsx('span', { style: styles.badgeTitle, children: model.badge.title }),
                model.badge.tag ? jsx(Tag, { tone: model.badge.tone, children: model.badge.tag }) : null,
              ],
            }),
            jsx('p', {
              key: 'detail',
              style: styles.detail,
              role: 'status',
              'aria-live': model.loginPhase === 'pending' ? 'polite' : 'off',
              children: model.badge.detail,
            }),
            jsx('dl', {
              key: 'facts',
              style: styles.facts,
              children: model.facts.flatMap((fact) => {
                const label = jsx('dt', { key: `${fact.key}-label`, style: styles.factLabel, children: fact.label });
                if (!fact.copy) return [label, jsx('dd', { key: `${fact.key}-value`, style: styles.factValue, children: fact.value })];
                return [
                  label,
                  jsxs(
                    'dd',
                    {
                      key: `${fact.key}-value`,
                      style: styles.factValue,
                      children: [
                        jsx('span', { children: fact.value }),
                        jsx(Button, {
                          variant: 'ghost',
                          size: 'sm',
                          title: t('copyStatePath'),
                          onClick: () => copy(fact.key, fact.copy),
                          children: copied === fact.key ? t('copied') : t('copy'),
                        }),
                      ],
                    },
                  ),
                ];
              }),
            }),
            model.loginPhase === 'pending'
              ? jsxs('div', {
                  key: 'pending',
                  style: styles.pending,
                  children: [
                    jsx('span', {
                      children: model.loginElapsed
                        ? `${t('loginPending')} ${t('loginWaiting', { time: model.loginElapsed })}.`
                        : t('loginPending'),
                    }),
                    model.loginUrl
                      ? jsxs('span', {
                          style: styles.copyRow,
                          children: [
                            jsx('a', { href: model.loginUrl, target: '_blank', rel: 'noreferrer', style: styles.link, children: model.loginUrl }),
                            jsx(Button, {
                              variant: 'ghost',
                              size: 'sm',
                              title: t('copyLoginUrl'),
                              onClick: () => copy('login', model.loginUrl),
                              children: copied === 'login' ? t('copied') : t('copy'),
                            }),
                          ],
                        })
                      : null,
                  ],
                })
              : null,
            model.error
              ? jsx('p', {
                  key: 'error',
                  style: styles.error,
                  role: 'alert',
                  children: `${t('lastError')}: ${model.error}${model.errorTransient ? ` — ${t('retryingAutomatically')}` : ''}`,
                })
              : null,
            jsxs('div', {
              key: 'actions',
              style: styles.actions,
              children: [
                jsx(Button, {
                  variant: model.canSignOut ? 'outline' : 'primary',
                  size: 'sm',
                  disabled: busy !== undefined || !model.canSignIn,
                  onClick: run('login'),
                  children: model.canSignOut ? t('signInAgain') : t('signIn'),
                }),
                model.loginPhase === 'pending'
                  ? jsx(Button, { size: 'sm', disabled: busy !== undefined, onClick: run('cancelLogin'), children: t('cancelLogin') })
                  : null,
                jsx(Button, { size: 'sm', title: t('reloadHint'), disabled: busy !== undefined, onClick: run('reload'), children: t('reload') }),
                model.canSignOut
                  ? jsx(Button, { variant: 'outline', size: 'sm', title: t('logoutHint'), disabled: busy !== undefined, onClick: run('logout'), children: t('logout') })
                  : null,
                jsx(Button, { variant: 'ghost', size: 'sm', disabled: busy !== undefined, onClick: refresh, children: t('refresh') }),
                busy !== undefined ? jsx('span', { style: styles.busy, children: model.busyHint }) : null,
              ],
            }),
          ],
        }),
        jsxs('section', {
          key: 'tools',
          style: styles.card,
          children: [
            jsxs('div', {
              key: 'toolsHead',
              style: styles.sectionHead,
              children: [
                jsx('span', { style: styles.sectionTitle, children: model.toolsTitle }),
                model.toolsSummary ? jsx('span', { style: styles.muted, children: model.toolsSummary }) : null,
              ],
            }),
            jsx(Input, {
              type: 'search',
              value: query,
              placeholder: t('toolsSearch'),
              'aria-label': t('toolsSearch'),
              style: styles.search,
              onChange: (event) => setState((previous) => ({ ...previous, query: event && event.target ? event.target.value : '' })),
            }),
            model.toolsEmpty
              ? jsx('p', { style: styles.detail, children: query.length > 0 ? t('toolsNoMatch', { query }) : t('noTools') })
              : jsx('ul', {
                  style: styles.toolList,
                  children: model.toolsShown.map((tool) =>
                    jsxs(
                      'li',
                      {
                        style: styles.toolRow,
                        children: [
                          jsxs('span', {
                            style: styles.toolHead,
                            children: [
                              jsx('span', { style: styles.toolName, children: tool.name }),
                              // The read-only label uses the neutral capsule: the
                              // primitives' `quiet` tone carries no fill, so it
                              // reads as unstyled text next to the write tag.
                              jsx(Tag, { tone: tool.readOnly ? 'neutral' : 'warning', children: tool.readOnly ? t('readOnly') : t('write') }),
                            ],
                          }),
                          tool.summary ? jsx('span', { style: styles.toolSummary, children: tool.summary }) : null,
                        ],
                      },
                      tool.name,
                    ),
                  ),
                }),
          ],
        }),
      ];

      return jsxs('div', { style: styles.root, children });
    }

    /** Required browser-side services: the slot registry and the dictionary registry. */
    const inject = ['slots', 'locale'];

    /**
     * Register the dictionaries and contribute the settings page.
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-flowus: dictionaries');
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'flowus',
                order: 32,
                label: () => t('nav'),
                locale: NS,
                inject: () => ({}),
              },
              FlowusSettingsPage,
            ),
          ),
        'dsh-flowus: settings page',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    // Exported for this repository's tests: the bundle is served as-is, so its
    // pure projections cannot be imported from a separate module.
    exports.__internals = { NS, API_PREFIX, LOGIN_POLL_MS, en, zh, api, statusViewModel, filterTools, timeAgo, describeAgo, FlowusSettingsPage };
    return module.exports;
  },
});
