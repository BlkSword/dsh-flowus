/**
 * Browser half of `@mars-sea/dsh-flowus`: the Settings → FlowUs page.
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
  id: '@mars-sea/dsh-flowus',
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
      loginPendingShort: 'Waiting for the browser…',
      loginPending: 'A browser tab was opened for the FlowUs authorization. Approve the request there; this page updates by itself.',
      openManually: 'Open the authorization page',
      loginFailed: 'Authorization failed',
      authorizedNotConnected: 'Authorized, not connected',
      connected: 'Connected',
      connectedDetail: 'Tools are published to the model.',
      signIn: 'Sign in with FlowUs',
      signInAgain: 'Re-authorize',
      cancelLogin: 'Cancel',
      reload: 'Reconnect',
      logout: 'Sign out',
      refresh: 'Refresh',
      server: 'MCP endpoint',
      namespace: 'Tool namespace',
      stateFile: 'Credential file',
      scope: 'Scope',
      expires: 'Expires',
      expiresNever: 'no expiry reported',
      refreshToken: 'Refresh token',
      yes: 'yes',
      no: 'no',
      tools: 'Tools',
      toolsCount: '{count} tool(s) published',
      noTools: 'No tools are published yet. Authorize, then use Reconnect.',
      lastSync: 'Last sync',
      lastError: 'Last error',
      busy: 'Working…',
      retry: 'Retry',
      unknownError: 'Unknown error',
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
      loginPendingShort: '等待浏览器授权…',
      loginPending: '已打开 FlowUs 授权页面，请在浏览器中确认；本页面会自动刷新。',
      openManually: '打开授权页面',
      loginFailed: '授权失败',
      authorizedNotConnected: '已授权，但未连接',
      connected: '已连接',
      connectedDetail: '工具已注册给模型使用。',
      signIn: '登录 FlowUs',
      signInAgain: '重新授权',
      cancelLogin: '取消',
      reload: '重新连接',
      logout: '退出登录',
      refresh: '刷新',
      server: 'MCP 地址',
      namespace: '工具命名空间',
      stateFile: '凭据文件',
      scope: '授权范围',
      expires: '过期时间',
      expiresNever: '未提供过期时间',
      refreshToken: 'Refresh token',
      yes: '有',
      no: '无',
      tools: '工具',
      toolsCount: '已注册 {count} 个工具',
      noTools: '还没有注册任何工具。完成授权后点「重新连接」。',
      lastSync: '上次同步',
      lastError: '最近错误',
      busy: '处理中…',
      retry: '重试',
      unknownError: '未知错误',
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
     * Project one snapshot into everything the page renders.
     *
     * Pure and string-complete: the React component only places what this
     * returns, so the page's whole presentation is testable without a DOM.
     * @param {object | undefined} snapshot - the host status snapshot.
     * @param {(key: string, values?: Record<string, string | number>) => string} t - dictionary reader.
     * @returns {object} the view model.
     */
    function statusViewModel(snapshot, t) {
      const auth = (snapshot && snapshot.authorization) || {};
      const connection = (snapshot && snapshot.connection) || {};
      const login = (snapshot && snapshot.login) || { phase: 'idle' };
      const tools = Array.isArray(snapshot && snapshot.tools) ? snapshot.tools : [];

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
          detail: t('authorizedDetail'),
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

      const facts = [
        { key: 'server', label: t('server'), value: (snapshot && snapshot.server && snapshot.server.url) || '—' },
        {
          key: 'namespace',
          label: t('namespace'),
          value: snapshot && snapshot.server && snapshot.server.namespace ? `${snapshot.server.namespace}*` : '—',
        },
        { key: 'stateFile', label: t('stateFile'), value: (snapshot && snapshot.server && snapshot.server.statePath) || '—' },
        { key: 'scope', label: t('scope'), value: auth.scope || '—' },
        { key: 'expires', label: t('expires'), value: auth.expiresAt || t('expiresNever') },
        { key: 'refreshToken', label: t('refreshToken'), value: auth.hasRefreshToken ? t('yes') : t('no') },
      ];
      if (connection.lastSyncAt) facts.push({ key: 'lastSync', label: t('lastSync'), value: connection.lastSyncAt });

      return {
        badge,
        facts,
        tools,
        toolsEmpty: tools.length === 0,
        toolsTitle: `${t('tools')} (${tools.length})`,
        loginPhase: login.phase,
        loginUrl: login.authorizationUrl || null,
        busyHint: t('busy'),
        canSignIn: login.phase !== 'pending',
        canSignOut: auth.configured === true,
        error: (snapshot && snapshot.lastError) || (login.phase === 'failed' ? login.error : null) || null,
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
      toolList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' },
      toolRow: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '0.82rem' },
      toolName: { fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)' },
      toolSummary: { color: 'var(--dsw-alias-text-tertiary, #8b8f96)' },
      busy: { fontSize: '0.8rem', color: 'var(--dsw-alias-text-tertiary, #8b8f96)' },
    };

    /**
     * Render the Settings → FlowUs page.
     * @param {object} props - framework props; `t` comes from the `settings.flowus` dictionary.
     * @returns {object} the React element tree.
     */
    function FlowusSettingsPage(props) {
      const t = props.t || ((key) => key);
      const [state, setState] = react.useState({ phase: 'loading', snapshot: undefined, error: undefined });
      const [busy, setBusy] = react.useState(undefined);

      const refresh = react.useCallback(async () => {
        try {
          const snapshot = await api.status();
          setState({ phase: 'ready', snapshot, error: undefined });
        } catch (error) {
          setState((previous) => ({
            phase: previous.snapshot ? 'ready' : 'failed',
            snapshot: previous.snapshot,
            error: (error && error.message) || String(error),
          }));
        }
      }, []);

      react.useEffect(() => {
        void refresh();
      }, [refresh]);

      const phase = state.snapshot && state.snapshot.login ? state.snapshot.login.phase : 'idle';
      react.useEffect(() => {
        if (phase !== 'pending') return undefined;
        const timer = setInterval(() => {
          void refresh();
        }, LOGIN_POLL_MS);
        return () => clearInterval(timer);
      }, [phase, refresh]);

      const run = react.useCallback(
        (action) => async () => {
          setBusy(action);
          try {
            const snapshot = await api[action]();
            setState({ phase: 'ready', snapshot, error: undefined });
          } catch (error) {
            setState((previous) => ({ ...previous, error: (error && error.message) || String(error) }));
          } finally {
            setBusy(undefined);
          }
        },
        [],
      );

      if (state.phase === 'loading') {
        return jsx('div', { style: styles.root, children: jsx('p', { style: styles.detail, children: t('loading') }) });
      }

      const model = statusViewModel(state.snapshot, t);
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
            jsx('p', { key: 'detail', style: styles.detail, children: model.badge.detail }),
            jsx('dl', {
              key: 'facts',
              style: styles.facts,
              children: model.facts.flatMap((fact) => [
                jsx('dt', { key: `${fact.key}-label`, style: styles.factLabel, children: fact.label }),
                jsx('dd', { key: `${fact.key}-value`, style: styles.factValue, children: fact.value }),
              ]),
            }),
            model.loginPhase === 'pending'
              ? jsxs('div', {
                  key: 'pending',
                  style: styles.pending,
                  children: [
                    jsx('span', { children: t('loginPending') }),
                    model.loginUrl
                      ? jsx('a', {
                          href: model.loginUrl,
                          target: '_blank',
                          rel: 'noreferrer',
                          style: styles.link,
                          children: `${t('openManually')}: ${model.loginUrl}`,
                        })
                      : null,
                  ],
                })
              : null,
            model.error ? jsx('p', { key: 'error', style: styles.error, children: `${t('lastError')}: ${model.error}` }) : null,
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
                jsx(Button, { size: 'sm', disabled: busy !== undefined, onClick: run('reload'), children: t('reload') }),
                model.canSignOut
                  ? jsx(Button, { variant: 'outline', size: 'sm', disabled: busy !== undefined, onClick: run('logout'), children: t('logout') })
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
            jsx('span', { style: styles.badgeTitle, children: model.toolsTitle }),
            model.toolsEmpty
              ? jsx('p', { style: styles.detail, children: t('noTools') })
              : jsx('ul', {
                  style: styles.toolList,
                  children: model.tools.map((tool) =>
                    jsxs(
                      'li',
                      {
                        style: styles.toolRow,
                        children: [
                          jsx('span', { style: styles.toolName, children: tool.name }),
                          tool.description
                            ? jsx('span', { style: styles.toolSummary, children: String(tool.description).split('\n')[0] })
                            : null,
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
    exports.__internals = { NS, API_PREFIX, LOGIN_POLL_MS, en, zh, api, statusViewModel, FlowusSettingsPage };
    return module.exports;
  },
});
