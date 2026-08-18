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
      "routes.hint": "共享 deepseek-v4-flash 的多条供应商路由。点击「设为默认」切换 agent-default-model（对新会话生效）。",
      "routes.loading": "加载中…",
      "routes.empty": "没有可用路由",
      "routes.default": "默认",
      "routes.serves": "提供 deepseek-v4-flash",
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
      "acp.min": "软阈值（压缩前）",
      "acp.max": "硬阈值（立即压缩）",
      "acp.save": "保存阈值",
      "acp.saving": "保存中…",
      "acp.saved": "阈值已保存（新会话生效）",
      "acp.failed": "保存失败：{error}",
      "error.load": "加载失败：{error}",
    };
    var EN = {
      "nav": "Model Routes",
      "section.description": "Switch the default model route (official / Ark / custom), export session handoffs, tune compaction thresholds",
      "routes.title": "Model routes",
      "routes.hint": "Every route serving deepseek-v4-flash. Click “Set default” to point agent-default-model at it (new sessions only).",
      "routes.loading": "Loading…",
      "routes.empty": "No routes available",
      "routes.default": "default",
      "routes.serves": "serves deepseek-v4-flash",
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
      "acp.min": "Soft limit (compress before)",
      "acp.max": "Hard limit (compress now)",
      "acp.save": "Save thresholds",
      "acp.saving": "Saving…",
      "acp.saved": "Thresholds saved (new sessions)",
      "acp.failed": "Save failed: {error}",
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
      ".dsh-ho__route{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,transparent)}",
      ".dsh-ho__route:first-of-type{border-top:0}",
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

      var routes = useState(null)[0];
      var setRoutes = useState(null)[1];
      var routesError = useState("")[0];
      var setRoutesError = useState("")[1];
      var acp = useState(null)[0];
      var setAcp = useState(null)[1];
      var draft = useState(null)[0];
      var setDraft = useState(null)[1];
      var busySwitch = useState(null)[0];
      var setBusySwitch = useState(null)[1];
      var busyExport = useState(false)[0];
      var setBusyExport = useState(false)[1];
      var busyAcp = useState(false)[0];
      var setBusyAcp = useState(false)[1];
      var message = useState("")[0];
      var setMessage = useState("")[1];
      var messageError = useState(false)[0];
      var setMessageError = useState(false)[1];
      var vision = useState({})[0];
      var setVision = useState({})[1];

      var load = useCallback(async function load() {
        try {
          var results = await Promise.all([apiGet("/routes"), apiGet("/acp")]);
          var r = results[0];
          var a = results[1];
          if (r && r.ok === true && Array.isArray(r.routes)) {
            setRoutes(r.routes);
            var initialVision = {};
            r.routes.forEach(function (route) { initialVision[route.provider] = false; });
            setVision(initialVision);
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
        } catch (error) {
          setRoutesError(String(error && error.message ? error.message : error));
        }
      }, []);

      useEffect(function () { load(); }, [load]);

      function switchTo(route) {
        if (busySwitch !== null) return;
        setBusySwitch(route.provider);
        setMessage("");
        apiPost("/switch", { provider: route.provider, vision: vision[route.provider] === true })
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

      // --- routes list ----------------------------------------------------
      var routeRows = [];
      if (routes !== null && routesError === "") {
        routeRows = routes.map(function (route) {
          var badges = [];
          if (route.default) {
            badges.push(h("span", { className: "dsh-ho__badge dsh-ho__badge--default", key: "d" }, t("routes.default")));
          }
          if (route.keyFamily === "(missing)" || route.keyFamily === "unknown") {
            badges.push(h("span", { className: "dsh-ho__badge dsh-ho__badge--warn", key: "k" }, t("routes.keyMissing")));
          } else {
            badges.push(h("span", { className: "dsh-ho__badge dsh-ho__badge--builtin", key: "k" }, route.keyEnv + " [" + route.keyFamily + "]"));
          }
          var metaBits = [route.baseURL || "?", route.note || ""];
          if (route.servesModel) metaBits.push(t("routes.serves"));
          var actions = [
            h("label", { className: "dsh-ho__checkbox", key: "v", title: t("routes.vision") },
              h("input", {
                type: "checkbox",
                checked: vision[route.provider] === true,
                disabled: busySwitch !== null,
                onChange: function (event) {
                  var next = Object.assign({}, vision);
                  next[route.provider] = event.target.checked;
                  setVision(next);
                },
              }),
              t("routes.vision"),
            ),
            h("button", {
              type: "button",
              key: "s",
              className: "dsh-ho__button dsh-ho__button--primary",
              disabled: busySwitch !== null || route.default,
              onClick: function () { switchTo(route); },
            }, busySwitch === route.provider ? t("routes.switching") : (route.default ? t("routes.default") : t("routes.switch"))),
          ];
          return h("div", { className: "dsh-ho__route", key: route.provider },
            h("div", { className: "dsh-ho__route-main" },
              h("div", { className: "dsh-ho__route-name" },
                route.provider,
                h("span", { style: { flex: "1 1 auto" } }),
                badges,
              ),
              h("div", { className: "dsh-ho__route-meta" }, metaBits.join(" · ")),
            ),
            h("div", { className: "dsh-ho__actions" }, actions),
          );
        });
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
          routes === null && routesError === "" ? h("p", { className: "dsh-ho__msg" }, t("routes.loading")) : null,
          routesError !== "" ? h("p", { className: "dsh-ho__msg dsh-ho__msg--error" }, t("error.load", { error: routesError })) : null,
          routes !== null && routes.length === 0 ? h("p", { className: "dsh-ho__msg" }, t("routes.empty")) : null,
          routeRows,
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
          sliderRows,
          h("div", { style: { display: "flex", justifyContent: "flex-end" } },
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
