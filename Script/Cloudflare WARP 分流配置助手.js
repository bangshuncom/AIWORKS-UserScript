// ==UserScript==
// @name         Cloudflare WARP 分流配置助手（GFWList 一键部署）
// @namespace    https://github.com/gfwlist-cf-warp
// @version      1.0.2
// @description  在 Cloudflare Zero Trust 控制台一键创建/切换 GFWList 分流配置：完整版(3985条)/精简版(核心站点)/国内直连。登录后打开 Zero Trust → 设备配置文件页面，点击悬浮按钮即可。
// @author       you
// @match        https://dash.cloudflare.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  /* ================= 配置 ================= */
  const PRECEDENCE = { full: 1, gfw2: 2, cn: 3, lite: 4 };
  const NAMES = {
    full: "GFWList 完整版",
    gfw2: "GFWList 完整版续",
    cn: "国内直连（绕过国内）",
    lite: "GFWList 精简版",
  };
  // 兼容手工创建过的配置名，避免重复建一份
  const ALIAS = {
    full: ["GFWList 完整版", "GFWList 模式（白名单）", "GFWList 模式"],
    gfw2: ["GFWList 完整版续", "GFWList 模式 2（白名单续）", "GFWList 模式 2"],
    cn: ["国内直连（绕过国内）", "国内直连"],
    lite: ["GFWList 精简版", "GFWList 精简版（核心站点）"],
  };
  const MAX_RULES = 3985; // 单配置上限 4000，留余量
  const LAN_CIDRS = [
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16",
    "100.64.0.0/10", "127.0.0.0/8", "fd00::/8", "fe80::/10",
    "224.0.0.0/4", "239.0.0.0/8", "255.255.255.255/32",
  ];
  const STEAM_CDN = [
    "23.32.0.0/11", "104.64.0.0/10", "146.66.152.0/21", "155.133.224.0/19",
    "162.254.192.0/18", "185.25.180.0/22", "192.69.96.0/22", "205.196.6.0/24",
  ];
  // 精简版核心站点（可自行增删）
  const CORE = [
    "google.com","youtube.com","googlevideo.com","ytimg.com","gstatic.com",
    "googleapis.com","googleusercontent.com","ggpht.com","gmail.com",
    "blogspot.com","blogger.com","youtube-nocookie.com","recaptcha.net",
    "openai.com","chatgpt.com","oaistatic.com","oaiusercontent.com","sora.com",
    "anthropic.com","claude.ai",
    "x.com","twitter.com","twimg.com","t.co","pbs.twimg.com",
    "telegram.org","t.me","tdesktop.com","telesco.pe",
    "github.com","githubusercontent.com","githubassets.com","github.io",
    "gitlab.com","stackoverflow.com","docker.com","docker.io","npmjs.com",
    "pypi.org","python.org","huggingface.co","kaggle.com","jetbrains.com",
    "vercel.com","netlify.com","jsdelivr.net","unpkg.com",
    "wikipedia.org","wikimedia.org","archive.org","medium.com","substack.com",
    "quora.com","reddit.com","redd.it","redditmedia.com","redditstatic.com",
    "bbc.com","bbc.co.uk","nytimes.com","wsj.com","reuters.com","bloomberg.com",
    "imgur.com","vimeo.com","soundcloud.com","patreon.com","wordpress.com",
    "netflix.com","nflxvideo.net","nflximg.net","twitch.tv","ttvnw.net",
    "spotify.com","scdn.co","pixiv.net","pximg.net","booth.pm","fanbox.cc",
    "nicovideo.jp","dmc.nico","line.me","kakao.com","naver.com",
    "facebook.com","fbcdn.net","instagram.com","cdninstagram.com",
    "whatsapp.com","whatsapp.net","messenger.com",
    "discord.com","discordapp.com","discordapp.net","discord.gg",
    "proton.me","protonmail.com","tutanota.com","signal.org","duckduckgo.com",
    "mozilla.org","torproject.org","mega.nz","dropbox.com","dropboxusercontent.com",
    "notion.so","notion.site","notion-static.com",
    "steamcommunity.com","steampowered.com","steamcontent.com","steamstatic.com",
    "cloudflare.com","workers.dev","pages.dev",
  ];
  // GFWList 订阅源（依次尝试；前三者为国内可达 CDN，末者为官方源兜底）
  const GFWLIST_URLS = [
    "https://fastly.jsdelivr.net/gh/gfwlist/gfwlist@master/gfwlist.txt",
    "https://cdn.jsdelivr.net/gh/gfwlist/gfwlist@master/gfwlist.txt",
    "https://testingcf.jsdelivr.net/gh/gfwlist/gfwlist@master/gfwlist.txt",
    "https://gh-proxy.com/https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt",
    "https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt",
  ];

  /* ================= 工具 ================= */
  const $ = (s) => document.querySelector(s);

  function accountId() {
    const m = location.pathname.match(/^\/([0-9a-f]{32})\//);
    return m ? m[1] : null;
  }

  async function api(method, path, body) {
    const r = await fetch(`/api/v4/accounts/${accountId()}${path}`, {
      method,
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-cross-site-security": "dash",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) { /* ignore */ }
    return { status: r.status, json: j, text: t };
  }

  const log = (msg, cls = "") => {
    const box = $("#gfw-log");
    if (!box) { console.log("[GFW]", msg); return; }
    const div = document.createElement("div");
    div.className = cls;
    div.textContent = msg;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  };

  /* ================= GFWList 解析 ================= */
  async function fetchGFWList() {
    for (const url of GFWLIST_URLS) {
      try {
        log(`下载 GFWList: ${new URL(url).host} ...`);
        const r = await fetch(url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        let text = await r.text();
        // 官方 gfwlist.txt 是 base64
        if (!text.includes("||") && /^[A-Za-z0-9+/=\s]+$/.test(text.slice(0, 200))) {
          text = atob(text.replace(/\s+/g, ""));
        }
        return text;
      } catch (e) {
        log(`  失败: ${e.message}`, "warn");
      }
    }
    throw new Error("所有订阅源均下载失败，请检查网络或手动添加镜像源");
  }

  // 提取被墙域名 → 归并到注册域
  function parseDomains(raw) {
    const twoLevel = new Set([
      "com.cn","net.cn","org.cn","gov.cn","edu.cn","co.jp","co.uk","com.au",
      "com.tw","com.hk","co.kr","com.sg","com.br","com.mx","or.jp","ne.jp",
      "com.tr","com.ru","com.my","com.ph","co.th","com.ar","co.nz",
    ]);
    const apex = (d) => {
      const p = d.split(".");
      if (p.length >= 3 && twoLevel.has(p.slice(-2).join("."))) return p.slice(-3).join(".");
      return p.slice(-2).join(".");
    };
    const out = [];
    const seen = new Set();
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("!") || s.startsWith("[") || s.startsWith("@@")) continue; // 跳过注释/白名单
      const m = s.match(/^\|\|([a-z0-9.-]+)\^?/i);
      if (!m) continue; // 跳过正则和路径规则
      let d = m[1].toLowerCase();
      if (d.includes("*") || !d.includes(".")) continue;
      d = d.replace(/^\*\./, "");
      const a = apex(d);
      if (a && !seen.has(a)) { seen.add(a); out.push(a); }
    }
    return out;
  }

  // 关键站点排在前面，保证截断时优先保留
  const PRIORITY = new Set(CORE);

  function buildFullInclude(apexes) {
    const order = [...apexes].sort((a, b) => {
      const pa = PRIORITY.has(a) ? 0 : 1, pb = PRIORITY.has(b) ? 0 : 1;
      return pa !== pb ? pa - pb : a.localeCompare(b);
    });
    const items = [];
    for (const a of order) {
      if (items.length + 1 > MAX_RULES) break;
      items.push({ host: "*." + a }); // 通配覆盖子域
    }
    // 前 150 个重要域补裸域（裸域与通配是独立匹配！）
    for (const a of order.slice(0, 150)) {
      if (items.length + 1 > MAX_RULES) break;
      items.push({ host: a });
    }
    return items;
  }

  function buildLiteInclude() {
    const items = [];
    const seen = new Set();
    for (const d of CORE) {
      for (const h of [d, "*." + d]) {
        if (!seen.has(h)) { seen.add(h); items.push({ host: h }); }
      }
    }
    for (const c of STEAM_CDN) items.push({ address: c });
    return items;
  }

  /* ================= 配置文件操作 ================= */
  async function listPolicies() {
    const r = await api("GET", "/devices/policies");
    if (r.status !== 200) throw new Error("读取配置列表失败: " + r.status);
    return r.json.result || [];
  }

  async function ensureProfile(kind, patchBody) {
    const name = NAMES[kind];
    const aliases = ALIAS[kind] || [name];
    const policies = await listPolicies();
    const exist = policies.find((p) => aliases.includes(p.name));
    if (exist) {
      log(`更新已有配置「${exist.name}」(${exist.policy_id.slice(0, 8)}) ...`);
      const r = await api("PATCH", `/devices/policy/${exist.policy_id}`, patchBody);
      if (r.status !== 200) throw new Error(`更新失败 ${r.status}: ${r.text.slice(0, 200)}`);
      log(`  更新成功：include ${(patchBody.include || []).length} 条 / exclude ${(patchBody.exclude || []).length} 条`, "ok");
      return exist.policy_id;
    }

    // ---------- 创建：include 与 exclude 不能同时出现（空数组也算） ----------
    const split = {};
    if ((patchBody.include || []).length) split.include = patchBody.include;
    if ((patchBody.exclude || []).length) split.exclude = patchBody.exclude;

    const me = await fetch("/api/v4/user", { credentials: "include" }).then((r) => r.json()).catch(() => null);
    const email = me?.result?.email || prompt("输入 Zero Trust 账号邮箱（用于设备匹配规则）:");
    if (!email) throw new Error("需要邮箱");

    const used = new Set(policies.map((p) => p.precedence).filter((n) => typeof n === "number"));
    const candidates = [PRECEDENCE[kind]];
    for (let i = 1; i <= 30; i++) if (!used.has(i)) candidates.push(i);
    candidates.push(Math.max(0, ...used) + 1);

    let lastErr = null;
    for (const prec of [...new Set(candidates)]) {
      log(`创建配置「${name}」（precedence=${prec}）...`);
      const body = Object.assign({
        name,
        match: `identity.email in {"${email}"}`,
        precedence: prec,
        enabled: false,
        profile_type: "warp",
        service_mode_v2: { mode: "warp" },
        allow_mode_switch: false,
        allow_updates: false,
        allowed_to_leave: true,
        auto_connect: 0,
        captive_portal: 180,
        switch_locked: false,
      }, split, patchBody.description ? { description: patchBody.description } : {});
      const r = await api("POST", "/devices/policy", body);
      if (r.status === 200 || r.status === 201) {
        log(`  创建成功: ${r.json.result.policy_id.slice(0, 8)}（precedence=${prec}）`, "ok");
        return r.json.result.policy_id;
      }
      lastErr = `${r.status}: ${r.text.slice(0, 200)}`;
      log(`  precedence=${prec} 失败 → ${r.text.slice(0, 120)}`, "warn");
      if (r.status !== 400) break; // 非字段冲突就没必要换号重试
    }
    throw new Error(`创建失败 ${lastErr}`);
  }

  /* ================= 部署动作 ================= */
  async function deployFull() {
    const raw = await fetchGFWList();
    const apexes = parseDomains(raw);
    log(`GFWList 原始域名归并到 ${apexes.length} 个注册域`);
    const include = buildFullInclude(apexes);
    log(`生成 ${include.length} 条规则（重要站点优先 + 裸域补强）`);
    await ensureProfile("full", { description: "GFWList 白名单模式", include, exclude: [] });
    log("✅ 完整版部署完成", "ok");
  }

  async function deployLite() {
    await ensureProfile("lite", { description: "GFWList 精简模式（核心站点）", include: buildLiteInclude(), exclude: [] });
    log("✅ 精简版部署完成", "ok");
  }

  async function deployCN() {
    log("读取默认配置的国内网段名单 ...");
    const r = await api("GET", "/devices/policy");
    if (r.status !== 200) throw new Error("读取默认配置失败");
    const excl = (r.json.result && r.json.result.exclude) || [];
    log(`默认配置 exclude ${excl.length} 条`);
    const have = new Set(excl.map((e) => e.address).filter(Boolean));
    for (const c of LAN_CIDRS) {
      if (!have.has(c) && excl.length < MAX_RULES) {
        excl.push({ address: c, description: "LAN" });
      }
    }
    log(`补内网后共 ${excl.length} 条`);
    await ensureProfile("cn", { description: "国内网段直连，其余走 WARP", include: [], exclude: excl });
    log("✅ 国内直连部署完成", "ok");
  }

  async function switchMode(kind) {
    const target = NAMES[kind];
    const policies = await listPolicies();
    const t = policies.find((p) => p.name === target);
    if (!t) throw new Error(`配置「${target}」不存在，请先部署`);
    for (const p of policies) {
      if (p.default) continue; // 默认配置不动
      const want = p.name === target;
      if (!!p.enabled === want) continue;
      const r = await api("PATCH", `/devices/policy/${p.policy_id}`, { enabled: want });
      log(`${want ? "启用" : "停用"}「${p.name}」: ${r.status === 200 ? "OK" : r.status}`);
    }
    log(`✅ 已切换到「${target}」，客户端约 20 秒内自动生效`, "ok");
  }

  async function showStatus() {
    const policies = await listPolicies();
    for (const p of policies.sort((a, b) => (a.precedence || 99999) - (b.precedence || 99999))) {
      const mode = (p.include || []).length ? "include" : (p.exclude || []).length ? "exclude" : "-";
      log(`[${p.enabled ? "ON " : "off"}] ${(p.name || "(默认)").padEnd(20)} prec=${p.precedence ?? "-"} ${mode} inc=${(p.include || []).length} exc=${(p.exclude || []).length}`);
    }
  }

  /* ================= UI ================= */
  function loadPos() {
    try { return JSON.parse(localStorage.getItem("gfw-panel-pos") || "null"); }
    catch (e) { return null; }
  }
  function savePos(x, y) {
    localStorage.setItem("gfw-panel-pos", JSON.stringify({ x, y }));
  }

  function buildUI() {
    if ($("#gfw-panel")) return;
    const panel = document.createElement("div");
    panel.id = "gfw-panel";
    panel.innerHTML = `
      <style>
        #gfw-panel{position:fixed;z-index:99999;font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
          background:#fff;color:#222;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.18);width:300px;user-select:none}
        #gfw-panel .hd{padding:10px 14px;font-weight:600;border-bottom:1px solid #eee;display:flex;justify-content:space-between;
          cursor:move;touch-action:none}
        #gfw-panel .hd .tt{pointer-events:none}
        #gfw-panel .hd #gfw-min{cursor:pointer;padding:0 4px;border-radius:4px}
        #gfw-panel .hd #gfw-min:hover{background:#eee}
        #gfw-panel .bd{padding:10px 14px;display:flex;flex-direction:column;gap:6px}
        #gfw-panel button{border:0;border-radius:6px;padding:7px 10px;cursor:pointer;font-size:13px;color:#fff}
        #gfw-panel .b1{background:#f6821f}#gfw-panel .b2{background:#4a90d9}
        #gfw-panel .b3{background:#6b7280}#gfw-panel .b4{background:#e05252}
        #gfw-panel button:disabled{opacity:.5;cursor:wait}
        #gfw-log{max-height:180px;overflow-y:auto;margin-top:8px;padding:8px;background:#f6f7f9;border-radius:6px;
          font:11px/1.5 Consolas,monospace;color:#333;white-space:pre-wrap;word-break:break-all;display:none}
        #gfw-log .ok{color:#0a7d32}#gfw-log .warn{color:#b45309}#gfw-log .err{color:#c0392b}
        /* 最小化：缩成 40px 小浮球，不挡内容 */
        #gfw-panel.min{width:auto;background:transparent;box-shadow:none;border-radius:50%}
        #gfw-panel.min .hd{display:none}
        #gfw-panel.min .bd{display:none}
        #gfw-ball{display:none;width:42px;height:42px;border-radius:50%;background:#f6821f;color:#fff;
          font-size:20px;line-height:42px;text-align:center;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.25);
          user-select:none;touch-action:none}
        #gfw-panel.min #gfw-ball{display:block}
      </style>
      <div class="hd"><span class="tt">🛡️ WARP 分流助手</span><span id="gfw-min" title="最小化为浮球">—</span></div>
      <div class="bd">
        <button class="b1" data-act="full">① 部署/更新 完整版（3985条）</button>
        <button class="b2" data-act="lite">② 部署/更新 精简版（核心站点）</button>
        <button class="b3" data-act="cn">③ 部署/更新 国内直连</button>
        <hr style="border:0;border-top:1px solid #eee;margin:2px 0">
        <button class="b1" data-act="sw-full">切换→ 完整版</button>
        <button class="b1" data-act="sw-lite">切换→ 精简版</button>
        <button class="b3" data-act="sw-cn">切换→ 国内直连</button>
        <button class="b4" data-act="status">查看当前状态</button>
        <div id="gfw-log"></div>
      </div>
      <div id="gfw-ball" title="点击展开">🛡️</div>`;
    document.body.appendChild(panel);

    // 位置：优先恢复上次位置，否则右上角
    const pos = loadPos();
    const place = (x, y) => {
      const w = panel.offsetWidth, h = panel.offsetHeight;
      x = Math.min(Math.max(0, x), innerWidth - 60);
      y = Math.min(Math.max(0, y), innerHeight - 60);
      panel.style.left = x + "px";
      panel.style.top = y + "px";
      panel.style.right = "auto";
    };
    if (pos) place(pos.x, pos.y);
    else { panel.style.top = "80px"; panel.style.right = "20px"; }

    // 通用拖拽（鼠标 + 触屏），最小化状态下拖浮球，展开状态拖标题栏
    function makeDraggable(handle) {
      let sx, sy, ox, oy, dragging = false, moved = false;
      const down = (e) => {
        const pt = e.touches ? e.touches[0] : e;
        sx = pt.clientX; sy = pt.clientY;
        const r = panel.getBoundingClientRect();
        ox = r.left; oy = r.top;
        dragging = true; moved = false;
        e.preventDefault();
      };
      const move = (e) => {
        if (!dragging) return;
        const pt = e.touches ? e.touches[0] : e;
        if (Math.abs(pt.clientX - sx) + Math.abs(pt.clientY - sy) > 4) moved = true;
        place(ox + pt.clientX - sx, oy + pt.clientY - sy);
        e.preventDefault();
      };
      const up = () => {
        if (dragging && moved) {
          const r = panel.getBoundingClientRect();
          savePos(Math.round(r.left), Math.round(r.top));
          // 拖拽松手会附带产生一次 click，把它吞掉，避免误触"最小化/展开"
          const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
          document.addEventListener("click", swallow, { capture: true, once: true });
          setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 250);
        }
        dragging = false;
      };
      handle.addEventListener("mousedown", down);
      handle.addEventListener("touchstart", down, { passive: false });
      document.addEventListener("mousemove", move);
      document.addEventListener("touchmove", move, { passive: false });
      document.addEventListener("mouseup", up);
      document.addEventListener("touchend", up);
    }
    makeDraggable(panel.querySelector(".hd"));
    makeDraggable($("#gfw-ball"));

    // 最小化/展开（点击浮球展开）
    $("#gfw-min").onclick = () => panel.classList.add("min");
    $("#gfw-ball").onclick = () => panel.classList.remove("min");

    panel.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      if (!accountId()) { log("请先进入某个账号的 Zero Trust 页面（URL 需含账户ID）", "err"); return; }
      const act = btn.dataset.act;
      const busy = (on) => panel.querySelectorAll("button").forEach((b) => (b.disabled = on));
      $("#gfw-log").style.display = "block";
      busy(true);
      try {
        if (act === "full") await deployFull();
        else if (act === "lite") await deployLite();
        else if (act === "cn") await deployCN();
        else if (act === "sw-full") await switchMode("full");
        else if (act === "sw-lite") await switchMode("lite");
        else if (act === "sw-cn") await switchMode("cn");
        else if (act === "status") { $("#gfw-log").innerHTML = ""; await showStatus(); }
      } catch (err) {
        log("❌ " + err.message, "err");
      } finally {
        busy(false);
      }
    });
  }

  // 延迟注入，等 SPA 渲染完成
  const timer = setInterval(() => {
    if (document.body && accountId()) {
      clearInterval(timer);
      buildUI();
    }
  }, 1500);
  setTimeout(() => clearInterval(timer), 30000);
})();
