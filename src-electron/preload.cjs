const { contextBridge, ipcRenderer } = require("electron");

const active = new Set();

contextBridge.exposeInMainWorld("meteorAPI", {
  info: () => ipcRenderer.invoke("meteor:info"),
  openFile: () => ipcRenderer.invoke("dialog:openFile"),
  saveFile: (args) => ipcRenderer.invoke("dialog:saveFile", args),
  openWorkspace: () => ipcRenderer.invoke("workspace:open"),
  refreshWorkspace: (root) => ipcRenderer.invoke("workspace:refresh", root),
  writeWorkspaceFile: (args) => ipcRenderer.invoke("workspace:writeFile", args),
  termGetCwd: () => ipcRenderer.invoke("term:getCwd"),
  termGetInfo: () => ipcRenderer.invoke("term:getInfo"),
  termExec: (id, cmd) => ipcRenderer.invoke("term:exec", { id, cmd }),
  termKill: (id) => ipcRenderer.invoke("term:kill", { id }),
  termOnData: (id, cb) => {
    const ch = `term:data:${id}`;
    const fn = (_e, d) => cb(d);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  termOnExit: (id, cb) => {
    const ch = `term:exit:${id}`;
    const fn = (_e, code) => cb(code);
    ipcRenderer.once(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  termOnClear: (id, cb) => {
    const ch = `term:clear:${id}`;
    const fn = () => cb();
    ipcRenderer.once(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  stream: (payload, handlers) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const streams = {
      chunk: ipcRenderer.on(`meteor:chunk:${id}`, (_e, text) => handlers.onChunk?.(text)),
      reasoning: ipcRenderer.on(`meteor:reasoning:${id}`, (_e, text) => handlers.onReasoning?.(text)),
      done: ipcRenderer.on(`meteor:done:${id}`, (_e, data) => cleanup("done", data)),
      error: ipcRenderer.once(`meteor:error:${id}`, (_e, msg) => cleanup("error", msg)),
      toolCall: ipcRenderer.on(`meteor:tool_call:${id}`, (_e, data) => handlers.onToolCall?.(data)),
      toolResult: ipcRenderer.on(`meteor:tool_result:${id}`, (_e, data) => handlers.onToolResult?.(data)),
      toolInfo: ipcRenderer.on(`meteor:tool_info:${id}`, (_e, data) => handlers.onToolInfo?.(data)),
      toolDelta: ipcRenderer.on(`meteor:tool_delta:${id}`, (_e, data) => handlers.onToolDelta?.(data)),
    };
    function cleanup(kind, msg) {
      active.delete({ id, streams, handlers });
      ipcRenderer.removeAllListeners(`meteor:chunk:${id}`);
      ipcRenderer.removeAllListeners(`meteor:reasoning:${id}`);
      ipcRenderer.removeAllListeners(`meteor:done:${id}`);
      ipcRenderer.removeAllListeners(`meteor:error:${id}`);
      ipcRenderer.removeAllListeners(`meteor:tool_call:${id}`);
      ipcRenderer.removeAllListeners(`meteor:tool_result:${id}`);
      ipcRenderer.removeAllListeners(`meteor:tool_info:${id}`);
      ipcRenderer.removeAllListeners(`meteor:tool_delta:${id}`);
      if (kind === "error") handlers.onError?.(msg);
      else handlers.onDone?.(msg);
    }
    active.add({ id, streams, handlers });
    ipcRenderer.invoke("meteor:complete", { ...payload, id });
    return function stop() {
      ipcRenderer.removeAllListeners(`meteor:chunk:${id}`);
      ipcRenderer.removeAllListeners(`meteor:reasoning:${id}`);
      ipcRenderer.removeAllListeners(`meteor:done:${id}`);
      ipcRenderer.removeAllListeners(`meteor:error:${id}`);
      ipcRenderer.removeAllListeners(`meteor:tool_call:${id}`);
      ipcRenderer.removeAllListeners(`meteor:tool_result:${id}`);
      ipcRenderer.removeAllListeners(`meteor:tool_info:${id}`);
      ipcRenderer.removeAllListeners(`meteor:tool_delta:${id}`);
      active.forEach((a) => a.id === id && active.delete(a));
    };
  },
  auth: {
    signUp: (email, password) => ipcRenderer.invoke("auth:signUp", { email, password }),
    signIn: (email, password) => ipcRenderer.invoke("auth:signIn", { email, password }),
    signOut: () => ipcRenderer.invoke("auth:signOut"),
    getSession: () => ipcRenderer.invoke("auth:getSession"),
    getUser: () => ipcRenderer.invoke("auth:getUser"),
    isConfigured: () => ipcRenderer.invoke("auth:isConfigured"),
  },
  profile: {
    get: () => ipcRenderer.invoke("profile:get"),
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    create: (payload) => ipcRenderer.invoke("projects:create", payload),
    get: (id) => ipcRenderer.invoke("projects:get", { id }),
    update: (id, updates) => ipcRenderer.invoke("projects:update", { id, updates }),
    delete: (id) => ipcRenderer.invoke("projects:delete", { id }),
    saveMessages: (projectId, messages) => ipcRenderer.invoke("projects:saveMessages", { projectId, messages }),
    loadMessages: (projectId) => ipcRenderer.invoke("projects:loadMessages", { projectId }),
    generateTitle: (projectId, firstMessage, firstResponse) => ipcRenderer.invoke("project:generateTitle", { projectId, firstMessage, firstResponse }),
  },
  mcp: {
    get: () => ipcRenderer.invoke("mcp:get"),
    save: (servers) => ipcRenderer.invoke("mcp:save", { servers }),
    saveJson: (jsonText) => ipcRenderer.invoke("mcp:saveJson", { jsonText }),
    test: (name) => ipcRenderer.invoke("mcp:test", { name }),
    disconnect: (name) => ipcRenderer.invoke("mcp:disconnect", { name }),
    validate: (jsonText) => ipcRenderer.invoke("mcp:validate", { jsonText }),
    listTools: () => ipcRenderer.invoke("mcp:listTools"),
    callTool: (server, tool, args) => ipcRenderer.invoke("mcp:callTool", { server, tool, args }),
  },
  git: {
    status: () => ipcRenderer.invoke("git:status"),
    diff: (path, staged) => ipcRenderer.invoke("git:diff", { path, staged }),
    diffFile: (path, staged) => ipcRenderer.invoke("git:diffFile", { path, staged }),
  },
  updater: {
    check: (force) => ipcRenderer.invoke("updater:check", { force }),
    getStatus: () => ipcRenderer.invoke("updater:getStatus"),
    install: () => ipcRenderer.invoke("updater:install"),
    openRepo: () => ipcRenderer.invoke("updater:openRepo"),
    restart: () => ipcRenderer.invoke("app:restart"),
  },
});
