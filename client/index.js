/**
 * dsh-session-handoff — web client (hand-written bundle, no build step).
 *
 * Registers a Settings section ("模型路由" / "Model Routes") that mirrors the
 * host-side tools in the GUI:
 *   1. Model routes panel — every route serving deepseek-v4-flash (official /
 *      Ark / custom), key family, default marker, one-click switch of
 *      agent-default-model (+ optional vision wrapper variant).
 *   2. Session handoff entry — export the current session into
 *      <workspace>/.dsh-handoff/handoff-<session>.md via the host route.
 *   3. ACP threshold sliders — soft/hard context limits (17-90%) persisted
 *      into settings.yaml's `session-handoff:` section via the host route.
 *
 * The shell loads this module through window.__ModuleLoader__.load(); the
 * factory receives a `require` that resolves react and the official client
 * runtime packages. Mirrors the dsh-session-manager client patterns
 * (settings.section slot, locale namespace, root-resolved services).
 */
window.__ModuleLoader__.load({
  id: "dsh-session-handoff",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;
    var useRef = react.useRef;

    /** Locale namespace id registered under ctx.locale. */
    var NS = "dsh-session-handoff";
    /** Required services: slots for the settings section, locale for the nav label, sessions for the current-session id. */
    var inject = ["slots", "locale", "sessions"];

    // ---------------------------------------------------------------------
    // locale dictionaries (key-set source of truth: zh)
    // ---------------------------------------------------------------------
    var ZH = {
      "nav": "模型路由",
      "section.description": "同模型多供应商（官方 / Ark / 自定义）一键切换 · 会话交接导出 · 上下文压缩阈值",
      "routes.title": "模型路由",
      "routes.hint": "按优先级排列的模型路由：拖拽排序、可删除/添加。当当前模型无法呼叫或额度耗尽时，自动切换列表中的下一个并继续工作（用户中断不会切换）。",
      "routes.loading": "加载中…",
      "routes.empty": "没有可用路由",
      "routes.default": "默认",
      "routes.serves": "已登记路由",
      "routes.key": "密钥",
      "routes.base": "接口",
      "routes.vision": "视觉变体",
      "routes.switch": "设为默认",
      "routes.switching": "切换中…",
      "routes.switched": "已切换到 {provider}（新会话生效）",
      "routes.switchFailed": "切换失败：{error}",
      "routes.builtin": "内置路由",
      "routes.configured": "已配置路由",
      "routes.keyMissing": "未找到密钥",
      "routes.current": "当前聊天模型：{provider} @ {model}",
      "failover.title": "自动切换（故障转移）",
      "failover.off": "未启用——加入至少一个路由后，模型不可用/额度耗尽时会自动切换。",
      "failover.add": "添加",
      "failover.remove": "移除",
      "failover.save": "保存优先级",
      "failover.saving": "保存中…",
      "failover.saved": "优先级已保存，新请求生效",
      "failover.saveFailed": "保存失败：{error}",
      "failover.empty": "所有可用路由都已加入列表",
      "failover.model": "模型（留空 = 跟随当前）",
      "failover.effort": "推理等级（留空 = 跟随当前）",
      "failover.modelFollow": "跟随当前",
      "failover.effortFollow": "跟随当前",
      "export.title": "会话交接",
      "export.hint": "把当前会话导出为结构化交接文档（.dsh-handoff/），新会话可直接续接。",
      "export.current": "当前会话：{session}",
      "export.none": "当前没有打开的会话",
      "export.button": "导出交接",
      "export.busy": "导出中…",
      "export.done": "交接文档已写入：{file}",
      "export.failed": "导出失败：{error}",
      "acp.title": "上下文压缩阈值",
      "acp.hint": "软阈值触发主动压缩提示，硬阈值强制压缩；写入 settings.yaml，对新会话生效。",
      "acp.current": "当前生效：软 {min} / 硬 {max}",
      "acp.min": "软阈值（压缩前）",
      "acp.max": "硬阈值（立即压缩）",
      "acp.save": "保存阈值",
      "acp.saving": "保存中…",
      "acp.saved": "阈值已保存（新会话生效）",
      "acp.failed": "保存失败：{error}",
      "acp.recommend": "固定推荐 65/90",
      "acp.recommending": "计算中…",
      "acp.recommended": "已填入固定推荐：软 {min} / 硬 {max}（点保存生效）",
      "error.load": "加载失败：{error}",
    };
    var EN = {
      "nav": "Model Routes",
      "section.description": "Switch the default model route (official / Ark / custom), export session handoffs, tune compaction thresholds",
      "routes.title": "Model routes",
      "routes.hint": "Priority-ordered model routes: drag to reorder, delete / add entries. When the active model is unreachable or out of quota, the next entry is tried automatically and work continues (user interruptions never switch).",
      "routes.loading": "Loading…",
      "routes.empty": "No routes available",
      "routes.default": "default",
      "routes.serves": "registered route",
      "routes.key": "key",
      "routes.base": "baseURL",
      "routes.vision": "vision variant",
      "routes.switch": "Set default",
      "routes.switching": "Switching…",
      "routes.switched": "Switched to {provider} (new sessions)",
      "routes.switchFailed": "Switch failed: {error}",
      "routes.builtin": "built-in route",
      "routes.configured": "configured route",
      "routes.keyMissing": "no key found",
      "routes.current": "Current chat model: {provider} @ {model}",
      "failover.title": "Auto failover",
      "failover.off": "Disabled — add at least one route and unreachable / out-of-quota models switch automatically.",
      "failover.add": "Add",
      "failover.remove": "Remove",
      "failover.save": "Save priority",
      "failover.saving": "Saving…",
      "failover.saved": "Priority saved, active for new requests",
      "failover.saveFailed": "Save failed: {error}",
      "failover.empty": "Every available route is already in the list",
      "failover.model": "model (blank = follow current)",
      "failover.effort": "reasoning effort (blank = follow current)",
      "failover.modelFollow": "follow current",
      "failover.effortFollow": "follow current",
      "export.title": "Session handoff",
      "export.hint": "Export the current session into a structured handoff document (.dsh-handoff/) a fresh session can resume from.",
      "export.current": "Current session: {session}",
      "export.none": "No session open",
      "export.button": "Export handoff",
      "export.busy": "Exporting…",
      "export.done": "Handoff written: {file}",
      "export.failed": "Export failed: {error}",
      "acp.title": "Compaction thresholds",
      "acp.hint": "The soft limit prompts proactive compression; the hard limit forces it. Written to settings.yaml, effective for new sessions.",
      "acp.current": "Current: soft {min} / hard {max}",
      "acp.min": "Soft limit (compress before)",
      "acp.max": "Hard limit (compress now)",
      "acp.save": "Save thresholds",
      "acp.saving": "Saving…",
      "acp.saved": "Thresholds saved (new sessions)",
      "acp.failed": "Save failed: {error}",
      "acp.recommend": "Fixed 65/90",
      "acp.recommending": "Computing…",
      "acp.recommended": "Filled fixed recommendation: soft {min} / hard {max} (click save to apply)",
      "error.load": "Load failed: {error}",
    };
    var dictionaries = { zh: ZH, en: EN };
    var currentLanguage = "zh";
    function setAppLocale(lang) {
      currentLanguage = typeof lang === "string" && lang.startsWith("zh") ? "zh" : "en";
    }
    function format(template, params) {
      return template.replace(/\{([a-zA-Z0-9]+)\}/g, function (match, name) {
        return name in params ? String(params[name]) : match;
      });
    }
    function t(key, params) {
      var template = (dictionaries[currentLanguage] || ZH)[key] || ZH[key];
      return params === undefined ? template : format(template, params);
    }

    // ---------------------------------------------------------------------
    // styles (injected once; CSS variables follow the shell appearance)
    // ---------------------------------------------------------------------
    var STYLE_ID = "dsh-session-handoff-style";
    var STYLE = [
      ".dsh-ho__wrap{display:flex;flex-direction:column;gap:16px}",
      ".dsh-ho__card{border:1px solid var(--dsw-alias-border-l2,#e2e4e9);background:var(--dsw-alias-bg-layer-2,transparent);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}",
      ".dsh-ho__title{color:var(--dsw-alias-label-primary,inherit);font-size:15px;font-weight:600;line-height:1.4;margin:0}",
      ".dsh-ho__hint{color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;line-height:1.5;margin:0}",
      ".dsh-ho__msg{color:var(--dsw-alias-label-secondary,inherit);font-size:12px;line-height:1.5;margin:0;word-break:break-all}",
      ".dsh-ho__msg--error{color:var(--dsw-alias-label-error,#d93025)}",
      ".dsh-ho__route{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,transparent);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent)}",
      ".dsh-ho__nav{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:4px}",
      ".dsh-ho__fo-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,transparent);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);cursor:grab;margin-bottom:6px}",
      ".dsh-ho__fo-row--drag{opacity:.45}",
      ".dsh-ho__fo-idx{flex:none;width:20px;text-align:center;color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;font-family:ui-monospace,Consolas,monospace}",
      ".dsh-ho__fo-handle{flex:none;color:var(--dsw-alias-label-tertiary,inherit);font-size:14px;cursor:grab;user-select:none;line-height:1}",
      ".dsh-ho__fo-opts{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}",
      ".dsh-ho__fo-select--sm{max-width:220px;padding:2px 6px;font-size:12px}",
      ".dsh-ho__fo-chips{display:flex;gap:4px;margin-top:4px;flex-wrap:wrap}",
      ".dsh-ho__fo-combo{position:relative;display:inline-block;min-width:180px}",
      ".dsh-ho__fo-combo .dsh-ho__fo-select{width:100%}",
      ".dsh-ho__fo-combo-list{display:none;position:absolute;z-index:20;top:100%;left:0;min-width:100%;max-height:150px;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,currentColor);border-radius:6px;margin-top:2px;box-shadow:0 2px 10px rgba(0,0,0,.18)}",
      ".dsh-ho__fo-combo:focus-within .dsh-ho__fo-combo-list{display:block}",
      ".dsh-ho__fo-combo-item{padding:3px 8px;font-size:12px;cursor:pointer;white-space:nowrap}",
      ".dsh-ho__fo-combo-item:hover{background:var(--dsw-alias-bg-layer-2,currentColor)}",
      ".dsh-ho__fo-combo-item--on{color:var(--dsw-alias-brand,currentColor);font-weight:600}",
      ".dsh-ho__fo-remove{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);font-size:14px;cursor:pointer;padding:2px 6px;border-radius:6px;line-height:1;flex:none}",
      ".dsh-ho__fo-remove:hover{color:var(--dsw-alias-label-error,#d93025);background:var(--dsw-alias-bg-module-platform,transparent)}",
      ".dsh-ho__fo-add{display:flex;align-items:center;gap:8px;margin-top:6px}",
      ".dsh-ho__fo-select{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2,#d0d3d9);border-radius:8px;padding:5px 8px}",
      ".dsh-ho__nav-arrow:disabled{opacity:.4;cursor:default}",
      ".dsh-ho__dot{appearance:none;border:0;background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-tertiary,inherit);min-width:22px;height:22px;padding:0 6px;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}",
      ".dsh-ho__dot--active{background:var(--dsw-alias-brand-primary,#4c6fff);color:#fff}",
      ".dsh-ho__route-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".dsh-ho__route-name{color:var(--dsw-alias-label-primary,inherit);font-size:13px;font-weight:600;font-family:ui-monospace,Consolas,monospace;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".dsh-ho__badge{font-size:10px;font-weight:500;line-height:1;padding:3px 6px;border-radius:999px;white-space:nowrap}",
      ".dsh-ho__badge--default{background:var(--dsw-alias-brand-primary,#4c6fff);color:#fff}",
      ".dsh-ho__badge--builtin{background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-secondary,inherit)}",
      ".dsh-ho__badge--warn{background:var(--dsw-alias-state-warn-primary,#b45309);color:#fff}",
      ".dsh-ho__route-meta{color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;line-height:1.4;font-family:ui-monospace,Consolas,monospace;word-break:break-all}",
      ".dsh-ho__actions{display:flex;align-items:center;gap:10px;flex:none}",
      ".dsh-ho__button{appearance:none;border:1px solid var(--dsw-alias-border-l2,#d0d3d9);background:var(--dsw-alias-bg-layer-3,transparent);color:var(--dsw-alias-label-primary,inherit);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}",
      ".dsh-ho__button:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,inherit)}",
      ".dsh-ho__button:disabled{opacity:.55;cursor:default}",
      ".dsh-ho__button--primary{background:var(--dsw-alias-brand-primary,#4c6fff);border-color:transparent;color:#fff}",
      ".dsh-ho__button--primary:hover:not(:disabled){filter:brightness(1.08)}",
      ".dsh-ho__slider-row{display:flex;align-items:center;gap:12px}",
      ".dsh-ho__slider-label{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,inherit);font-size:12px}",
      ".dsh-ho__slider{flex:2;min-width:0;accent-color:var(--dsw-alias-brand-primary,#4c6fff)}",
      ".dsh-ho__slider-value{flex:none;width:48px;text-align:right;color:var(--dsw-alias-label-primary,inherit);font-size:12px;font-family:ui-monospace,Consolas,monospace}",
      ".dsh-ho__checkbox{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;white-space:nowrap}",
      ".dsh-ho__skeleton{display:flex;flex-direction:column;gap:8px;padding:6px 0}",
      ".dsh-ho__skeleton-bar{height:12px;border-radius:6px;background:var(--dsw-alias-bg-module-platform,transparent);opacity:.5;animation:dsh-ho-pulse 1.2s ease-in-out infinite}",
      "@keyframes dsh-ho-pulse{0%,100%{opacity:.35}50%{opacity:.7}}",
    ].join("");

    // ---------------------------------------------------------------------
    // host route helpers
    // ---------------------------------------------------------------------
    var ROUTE_PREFIX = "/dsh-session-handoff";
    async function apiGet(path) {
      var response = await fetch(ROUTE_PREFIX + path);
      return response.json();
    }
    async function apiPost(path, body) {
      var response = await fetch(ROUTE_PREFIX + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return response.json();
    }
    function percentOf(limit) {
      var n = parseInt(String(limit ?? ""), 10);
      return Number.isFinite(n) ? Math.min(90, Math.max(17, n)) : 60;
    }

    // ---------------------------------------------------------------------
    // the settings-section panel
    // ---------------------------------------------------------------------
    function HandoffSettingsSection(props) {
      var sessions = props.sessions;
      var currentSession = sessions && sessions.list ? sessions.list.getSnapshot().current : undefined;

      // NOTE: each pair must come from ONE useState call — `useState(x)[0]`
      // followed by a separate `useState(x)[1]` would bind the setter to a
      // different hook than the reader, so state updates would never render.
      var routesPair = useState(null);
      var routes = routesPair[0];
      var setRoutes = routesPair[1];
      var routesErrorPair = useState("");
      var routesError = routesErrorPair[0];
      var setRoutesError = routesErrorPair[1];
      var acpPair = useState(null);
      var acp = acpPair[0];
      var setAcp = acpPair[1];
      var draftPair = useState(null);
      var draft = draftPair[0];
      var setDraft = draftPair[1];
      var busySwitchPair = useState(null);
      var busySwitch = busySwitchPair[0];
      var setBusySwitch = busySwitchPair[1];
      var busyExportPair = useState(false);
      var busyExport = busyExportPair[0];
      var setBusyExport = busyExportPair[1];
      var busyAcpPair = useState(false);
      var busyAcp = busyAcpPair[0];
      var setBusyAcp = busyAcpPair[1];
      var messagePair = useState("");
      var message = messagePair[0];
      var setMessage = messagePair[1];
      var messageErrorPair = useState(false);
      var messageError = messageErrorPair[0];
      var setMessageError = messageErrorPair[1];
      var visionPair = useState({});
      var vision = visionPair[0];
      var setVision = visionPair[1];
      var activePair = useState(0);
      var active = activePair[0];
      var setActive = activePair[1];
      var trackRef = useRef(null);
      var failoverPair = useState([]);
      var failoverList = failoverPair[0];
      var setFailoverList = failoverPair[1];
      var failoverLoadedPair = useState(false);
      var failoverLoaded = failoverLoadedPair[0];
      var setFailoverLoaded = failoverLoadedPair[1];
      var addValuePair = useState("");
      var addValue = addValuePair[0];
      var setAddValue = addValuePair[1];
      var dragIndexPair = useState(null);
      var dragIndex = dragIndexPair[0];
      var setDragIndex = dragIndexPair[1];
      var busyFailoverPair = useState(false);
      var busyFailover = busyFailoverPair[0];
      var setBusyFailover = busyFailoverPair[1];
      var currentPair = useState(null);
      var currentChat = currentPair[0];
      var setCurrentChat = currentPair[1];

      var load = useCallback(async function load() {
        try {
          var results = await Promise.all([apiGet("/routes"), apiGet("/acp"), apiGet("/failover")]);
          var r = results[0];
          var a = results[1];
          if (r && r.ok === true && Array.isArray(r.routes)) {
            setRoutes(r.routes);
            var initialVision = {};
            r.routes.forEach(function (route) { initialVision[route.provider] = false; });
            setVision(initialVision);
            setCurrentChat(r.current && r.current.provider ? r.current : null);
          } else {
            setRoutesError(r && r.error ? r.error : "bad-response");
          }
          if (a && a.ok === true && a.section) {
            setAcp(a.section);
            setDraft({
              min: percentOf(a.section.minContextLimit),
              max: Math.max(percentOf(a.section.minContextLimit), percentOf(a.section.maxContextLimit)),
            });
          }
          var f = results[2];
          if (f && f.ok === true && Array.isArray(f.routes)) {
            setFailoverList(f.routes);
            setFailoverLoaded(true);
          }
        } catch (error) {
          setRoutesError(String(error && error.message ? error.message : error));
        }
      }, []);

      useEffect(function () { load(); }, [load]);

      // keep the carousel on the first slide whenever the route list reloads
      useEffect(function () {
        setActive(0);
        var el = trackRef.current;
        if (el) el.scrollLeft = 0;
      }, [routes]);

      function switchTo(route) {
        if (busySwitch !== null) return;
        setBusySwitch(route.provider);
        setMessage("");
        apiPost("/switch", { provider: route.provider })
          .then(function (result) {
            if (result && result.ok === true) {
              setMessage(t("routes.switched", { provider: result.provider }));
              setMessageError(false);
              setRoutes((routes.map(function (r) {
                return Object.assign({}, r, { default: r.provider === route.provider });
              })));
            } else {
              setMessage(t("routes.switchFailed", { error: result && result.error ? result.error : "unknown" }));
              setMessageError(true);
            }
          })
          .catch(function (error) {
            setMessage(t("routes.switchFailed", { error: String(error && error.message ? error.message : error) }));
            setMessageError(true);
          })
          .finally(function () { setBusySwitch(null); });
      }

      function exportHandoff() {
        if (busyExport || !currentSession) return;
        setBusyExport(true);
        setMessage("");
        apiPost("/export", { sessionId: currentSession })
          .then(function (result) {
            if (result && result.ok === true) {
              setMessage(t("export.done", { file: result.file }));
              setMessageError(false);
            } else {
              setMessage(t("export.failed", { error: result && result.error ? result.error : "unknown" }));
              setMessageError(true);
            }
          })
          .catch(function (error) {
            setMessage(t("export.failed", { error: String(error && error.message ? error.message : error) }));
            setMessageError(true);
          })
          .finally(function () { setBusyExport(false); });
      }

      function saveAcp() {
        if (busyAcp || draft === null) return;
        if (draft.min >= draft.max) {
          setMessage(t("acp.failed", { error: "min >= max" }));
          setMessageError(true);
          return;
        }
        setBusyAcp(true);
        setMessage("");
        apiPost("/acp", {
          minContextLimit: draft.min + "%",
          maxContextLimit: draft.max + "%",
        })
          .then(function (result) {
            if (result && result.ok === true) {
              setAcp(result.section);
              setMessage(t("acp.saved"));
              setMessageError(false);
            } else {
              setMessage(t("acp.failed", { error: result && result.error ? result.error : "unknown" }));
              setMessageError(true);
            }
          })
          .catch(function (error) {
            setMessage(t("acp.failed", { error: String(error && error.message ? error.message : error) }));
            setMessageError(true);
          })
          .finally(function () { setBusyAcp(false); });
      }

      // Fixed recommendation — no per-session computation: deepseek-v4-flash
      // is a 1M-window model, so soft 65 / hard 90 is the sane default.
      function recommendAcp() {
        if (busyAcp) return;
        setDraft({ min: 65, max: 90 });
        setMessage(t("acp.recommended", { min: 65, max: 90 }));
        setMessageError(false);
      }

      // --- failover priority list (drag to reorder, delete / add) ----
      var failoverRows = [];
      if (failoverLoaded && routes !== null) {
        var routeById = {};
        routes.forEach(function (route) { routeById[route.provider] = route; });
        // Aggregate model suggestions: every model registered on ANY route, so
        // built-in routes (deepseek-official etc.) still get clickable candidates.
        var allModels = [];
        routes.forEach(function (route) {
          if (route && Array.isArray(route.models)) {
            route.models.forEach(function (m) {
              if (m && allModels.indexOf(m) === -1) allModels.push(m);
            });
          }
        });
        var BUILTIN_DEFAULTS = {
          "deepseek-official": ["deepseek-chat", "deepseek-reasoner"],
          "deepseek": ["deepseek-v4-flash"],
        };
        failoverRows = failoverList.map(function (entry, index) {
          var provider = typeof entry === 'string' ? entry : entry.provider;
          var model = typeof entry === 'string' ? '' : (entry.model || '');
          var effort = typeof entry === 'string' ? '' : (entry.effort || '');
          var route = routeById[provider] || null;
          var badges = [];
          if (route !== null) {
            if (route.default) {
              badges.push(h("span", { className: "dsh-ho__badge dsh-ho__badge--default", key: "d" }, t("routes.default")));
            }
            if (route.keyFamily === "(missing)" || route.keyFamily === "unknown") {
              badges.push(h("span", { className: "dsh-ho__badge dsh-ho__badge--warn", key: "k" }, t("routes.keyMissing")));
            } else {
              badges.push(h("span", { className: "dsh-ho__badge dsh-ho__badge--builtin", key: "k" }, (route.keyEnv || "?") + " [" + (route.keyFamily || "?") + "]"));
            }
          }
          // Per-route model picker: registered models for registered routes;
          // built-in routes (no registered models) fall back to the union of
          // every route's models + provider defaults + the chat's current
          // model + the pinned model — always a non-empty suggestion list.
          var modelOptions = [];
          var ownModels = route !== null && Array.isArray(route.models) ? route.models : [];
          var suggestFrom = ownModels.length > 0
            ? ownModels
            : allModels.concat(BUILTIN_DEFAULTS[provider] || []);
          suggestFrom.forEach(function (m) {
            if (m && modelOptions.indexOf(m) === -1) modelOptions.push(m);
          });
          if (currentChat !== null && currentChat.model && modelOptions.indexOf(currentChat.model) === -1) modelOptions.push(currentChat.model);
          if (model && modelOptions.indexOf(model) === -1) modelOptions.push(model);
          var effortOptions = ["", "max", "high", "medium", "low", "none"];
          function updateEntry(patch) {
            setFailoverList(failoverList.map(function (e) {
              var p = typeof e === 'string' ? e : e.provider;
              if (p !== provider) return e;
              return Object.assign({}, (typeof e === 'string' ? { provider: e } : e), patch);
            }));
          }
          var actions = [];
          if (route !== null) {
            if (!route.default) {
              actions.push(h("button", {
                type: "button",
                key: "s",
                className: "dsh-ho__button",
                disabled: busySwitch !== null,
                onClick: function () { switchTo(route); },
              }, busySwitch === provider ? t("routes.switching") : t("routes.switch")));
            }
          }
          actions.push(h("button", {
            type: "button",
            key: "x",
            className: "dsh-ho__fo-remove",
            title: t("failover.remove"),
            onClick: function () {
              setFailoverList(failoverList.filter(function (e) {
                return (typeof e === 'string' ? e : e.provider) !== provider;
              }));
            },
          }, "✕"));
          return h("div", {
            className: "dsh-ho__fo-row" + (dragIndex === index ? " dsh-ho__fo-row--drag" : ""),
            key: provider,
            draggable: true,
            onDragStart: function () { setDragIndex(index); },
            onDragOver: function (event) { event.preventDefault(); },
            onDrop: function () {
              var from = dragIndex;
              setDragIndex(null);
              if (from === null || from === index) return;
              var next = failoverList.slice();
              var item = next.splice(from, 1)[0];
              next.splice(index, 0, item);
              setFailoverList(next);
            },
            onDragEnd: function () { setDragIndex(null); },
          },
            h("span", { className: "dsh-ho__fo-handle" }, "⠿"),
            h("span", { className: "dsh-ho__fo-idx" }, String(index + 1) + "."),
            h("div", { className: "dsh-ho__route-main" },
              h("div", { className: "dsh-ho__route-name" }, provider, h("span", { style: { flex: "1 1 auto" } }), badges),
              h("div", { className: "dsh-ho__fo-opts" },
                h("div", { className: "dsh-ho__fo-combo" },
                  h("input", {
                    className: "dsh-ho__fo-select dsh-ho__fo-select--sm",
                    type: "text",
                    value: model,
                    placeholder: t("failover.modelFollow"),
                    title: t("failover.model"),
                    onChange: function (event) { updateEntry({ model: event.target.value }); },
                  }),
                  h("div", { className: "dsh-ho__fo-combo-list" },
                    modelOptions
                      .filter(function (m) {
                        if (model === "") return true;
                        return m.toLowerCase().indexOf(model.toLowerCase()) !== -1;
                      })
                      .map(function (m) {
                        return h("div", {
                          key: m,
                          className: "dsh-ho__fo-combo-item" + (model === m ? " dsh-ho__fo-combo-item--on" : ""),
                          onClick: function () { updateEntry({ model: m }); },
                        }, m);
                      }),
                  ),
                ),
                h("select", {
                  className: "dsh-ho__fo-select dsh-ho__fo-select--sm",
                  value: effort,
                  title: t("failover.effort"),
                  onChange: function (event) { updateEntry({ effort: event.target.value }); },
                },
                  effortOptions.map(function (v) {
                    return h("option", { key: v, value: v }, v === "" ? t("failover.effortFollow") : v);
                  }),
                ),
              ),
            ),
            h("div", { className: "dsh-ho__actions" }, actions),
          );
        });
      }
      var addProviderValues = [];
      var addOptions = [];
      if (routes !== null) {
        addProviderValues = routes
          .filter(function (route) {
            return !failoverList.some(function (e) { return (typeof e === 'string' ? e : e.provider) === route.provider; });
          })
          .map(function (route) { return route.provider; });
        addOptions = addProviderValues.map(function (provider) {
          return h("option", { key: provider, value: provider }, provider);
        });
      }
      // When there is exactly one candidate (or the previous pick is gone),
      // auto-select it so the add button is never stuck disabled.
      var addValueEffective = addProviderValues.length === 1
        ? addProviderValues[0]
        : (addValue !== "" && addProviderValues.indexOf(addValue) !== -1 ? addValue : "");
      var addRow = [];
      if (routes !== null && routes.length > 0) {
        addRow = [
          h("div", { className: "dsh-ho__fo-add", key: "add" },
            h("select", {
              className: "dsh-ho__fo-select",
              value: addValueEffective,
              disabled: addOptions.length === 0,
              onChange: function (event) { setAddValue(event.target.value); },
            },
              addOptions.length === 0 ? h("option", { value: "" }, t("failover.empty")) : addOptions,
            ),
            h("button", {
              type: "button",
              className: "dsh-ho__button",
              disabled: addValueEffective === "" || addOptions.length === 0,
              onClick: function () {
                if (addValueEffective === "") return;
                setFailoverList(failoverList.concat([{ provider: addValueEffective }]));
                setAddValue("");
              },
            }, t("failover.add")),
          ),
        ];
      }
      function saveFailover() {
        if (busyFailover) return;
        setBusyFailover(true);
        setMessage("");
        apiPost("/failover", { providers: failoverList })
          .then(function (result) {
            if (result && result.ok === true) {
              setFailoverList(result.routes);
              setMessage(t("failover.saved"));
              setMessageError(false);
            } else {
              setMessage(t("failover.saveFailed", { error: result && result.error ? result.error : "unknown" }));
              setMessageError(true);
            }
          })
          .catch(function (error) {
            setMessage(t("failover.saveFailed", { error: String(error && error.message ? error.message : error) }));
            setMessageError(true);
          })
          .finally(function () { setBusyFailover(false); });
      }

      // --- acp sliders -----------------------------------------------------
      var sliderRows = [];
      if (draft !== null) {
        var minValue = typeof draft.min === "number" ? draft.min : percentOf(acp && acp.minContextLimit);
        var maxValue = typeof draft.max === "number" ? draft.max : percentOf(acp && acp.maxContextLimit);
        sliderRows = [
          h("div", { className: "dsh-ho__slider-row", key: "min" },
            h("label", { className: "dsh-ho__slider-label", htmlFor: "dsh-ho-min" }, t("acp.min")),
            h("input", {
              id: "dsh-ho-min",
              className: "dsh-ho__slider",
              type: "range",
              min: 17,
              max: 90,
              step: 1,
              value: minValue,
              disabled: busyAcp,
              onChange: function (event) {
                var next = Object.assign({}, draft, { min: Number(event.target.value) });
                if (next.max <= next.min) next.max = Math.min(90, next.min + 1);
                setDraft(next);
              },
            }),
            h("span", { className: "dsh-ho__slider-value" }, minValue + "%"),
          ),
          h("div", { className: "dsh-ho__slider-row", key: "max" },
            h("label", { className: "dsh-ho__slider-label", htmlFor: "dsh-ho-max" }, t("acp.max")),
            h("input", {
              id: "dsh-ho-max",
              className: "dsh-ho__slider",
              type: "range",
              min: 17,
              max: 90,
              step: 1,
              value: maxValue,
              disabled: busyAcp,
              onChange: function (event) {
                var next = Object.assign({}, draft, { max: Number(event.target.value) });
                if (next.max <= next.min) next.min = Math.max(17, next.max - 1);
                setDraft(next);
              },
            }),
            h("span", { className: "dsh-ho__slider-value" }, maxValue + "%"),
          ),
        ];
      }

      var currentSessionText = currentSession
        ? t("export.current", { session: currentSession })
        : t("export.none");

      return h("div", { className: "dsh-ho__wrap" },
        h("p", { className: "dsh-ho__hint" }, t("section.description")),
        message === "" ? null : h("p", { className: "dsh-ho__msg" + (messageError ? " dsh-ho__msg--error" : "") }, message),
        // 1. model routes
        h("div", { className: "dsh-ho__card" },
          h("p", { className: "dsh-ho__title" }, t("routes.title")),
          h("p", { className: "dsh-ho__hint" }, t("routes.hint")),
          currentChat !== null ? h("p", { className: "dsh-ho__msg", key: "cur" }, t("routes.current", { provider: currentChat.provider, model: currentChat.model })) : null,
          routes === null && routesError === "" ? h("div", { className: "dsh-ho__skeleton", key: "sk" },
            h("div", { className: "dsh-ho__skeleton-bar", style: { width: "85%" } }),
            h("div", { className: "dsh-ho__skeleton-bar", style: { width: "60%" } }),
          ) : null,
          routesError !== "" ? h("p", { className: "dsh-ho__msg dsh-ho__msg--error" }, t("error.load", { error: routesError })) : null,
          routes !== null && routes.length === 0 ? h("p", { className: "dsh-ho__msg" }, t("routes.empty")) : null,
          failoverLoaded && failoverList.length === 0 ? h("p", { className: "dsh-ho__msg", key: "off" }, t("failover.off")) : null,
          failoverRows,
          addRow,
          failoverLoaded ? h("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" }, key: "save" },
            h("button", {
              type: "button",
              className: "dsh-ho__button dsh-ho__button--primary",
              disabled: busyFailover || failoverList.length === 0,
              onClick: saveFailover,
            }, busyFailover ? t("failover.saving") : t("failover.save")),
          ) : null,
        ),
        // 2. session handoff
        h("div", { className: "dsh-ho__card" },
          h("p", { className: "dsh-ho__title" }, t("export.title")),
          h("p", { className: "dsh-ho__hint" }, t("export.hint")),
          h("div", { className: "dsh-ho__slider-row" },
            h("span", { className: "dsh-ho__slider-label" }, currentSessionText),
            h("button", {
              type: "button",
              className: "dsh-ho__button dsh-ho__button--primary",
              disabled: busyExport || !currentSession,
              onClick: exportHandoff,
            }, busyExport ? t("export.busy") : t("export.button")),
          ),
        ),
        // 3. ACP thresholds
        h("div", { className: "dsh-ho__card" },
          h("p", { className: "dsh-ho__title" }, t("acp.title")),
          h("p", { className: "dsh-ho__hint" }, t("acp.hint")),
          acp !== null ? h("p", { className: "dsh-ho__msg" }, t("acp.current", { min: acp.minContextLimit, max: acp.maxContextLimit })) : null,
          sliderRows,
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } },
            h("button", {
              type: "button",
              className: "dsh-ho__button",
              disabled: busyAcp,
              title: t("acp.hint"),
              onClick: recommendAcp,
            }, busyAcp ? t("acp.recommending") : t("acp.recommend")),
            h("button", {
              type: "button",
              className: "dsh-ho__button",
              disabled: busyAcp || draft === null,
              onClick: saveAcp,
            }, busyAcp ? t("acp.saving") : t("acp.save")),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // apply
    // ---------------------------------------------------------------------
    function apply(ctx) {
      if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
        var tag = document.createElement("style");
        tag.dataset.plugin = "dsh-session-handoff";
        tag.dataset.pluginCss = STYLE_ID;
        tag.textContent = STYLE;
        document.head.appendChild(tag);
      }

      // Resolve services at the ROOT context (apply time): the slot `inject:`
      // callbacks run inside the slot's own scope, where these services are
      // not declared. Mirrors the dsh-session-manager client.
      var sessions = ctx.sessions;

      var syncLocale = function () { setAppLocale(ctx.locale.getLocale().active); };
      syncLocale();
      ctx.effect(function () {
        var unsubscribe = ctx.locale.subscribe(syncLocale);
        return function () { unsubscribe(); };
      }, "dsh-session-handoff: locale sync");

      ctx.effect(function () {
        return ctx.locale.register(NS, dictionaries);
      }, "dsh-session-handoff: dictionaries");

      var tNav = ctx.locale.bind(NS);

      ctx.slots.inject("settings.section", function () {
        var disposeRegistration = ctx.slots.register({
          name: "settings.section",
          id: "dsh-session-handoff",
          order: 60,
          label: function () { return tNav("nav"); },
          locale: NS,
          inject: function () { return { sessions: sessions }; },
        }, HandoffSettingsSection);
        return disposeRegistration;
      });
    }

    exports.NS = NS;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
