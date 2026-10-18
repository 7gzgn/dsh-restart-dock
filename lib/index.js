/**
 * dsh-restart-dock · 宿主半
 *
 * 一句话：给界面右下角那个小框提供两个动作 —— **重启宿主**、**看上次重启成没成**。
 * （「刷新页面」不需要宿主，client 半自己就能做。）
 *
 * 为什么要在插件里做重启：
 *   改插件、改 client.js、改 profile 配置之后，DSH 要重载才生效。以前只能关窗口再找快捷方式。
 *   这个入口把那条手工链路变成一次点击 —— 但**默认保守**：重启要连点两次确认，
 *   跨源页面一律拒绝（重启会打断一切，不能让人从别的网页 POST 过来）。
 *
 * 能力面（很小，写清楚）：
 *   GET  /dsh-restart-dock/status   只读：宿主 pid / 端口 / 平台 / 上次重启报告
 *   POST /dsh-restart-dock/restart  动作：起一个脱离宿主的 PowerShell helper 去「停 + 拉」
 *
 * 红线：
 *   · 只接受同源请求，并且要求自定义头 `x-dsh-restart-dock: 1`（跨源会先撞 preflight → 我们不答 → 打不进来）；
 *   · 目标进程**显式探测**：从宿主 pid 往上找到 DSH 应用顶层，找不到就拒绝，绝不猜；
 *   · 响应里不带任何凭据，也不回显无关的进程信息。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';

export const name = 'dsh-restart-dock';
export const inject = [];

const ROUTE_STATUS = '/dsh-restart-dock/status';
const ROUTE_RESTART = '/dsh-restart-dock/restart';
const ROUTE_BUNDLE = '/dsh-restart-dock/bundle-ready';
const HEADER_MARK = 'x-dsh-restart-dock';

/** 状态目录：与其它自建插件同口径（~/.dsh/<pkg>/）。 */
function stateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-restart-dock');
}

function readJson(file) {
  try {
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ 同源判断 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]']);

/**
 * 这个请求能不能被当成「同一个界面发来的」？
 *
 * 真正的防线是**自定义头**：跨源网页想带 `x-dsh-restart-dock`，必须先过 CORS preflight，
 * 而本插件不答 preflight → 浏览器根本不会把真请求发出来。
 * 所以这里不再强求 Origin：实测桌面 app 的 `dsh-app://` 页面连 POST 都不带 Origin、
 * 也不带 `Sec-Fetch-Site`，强求它只会把界面自己的按钮全挡成 403。
 *
 * 剩下的两条是加固：
 *   · 浏览器明确标了 `Sec-Fetch-Site: cross-site` → 直接拒；
 *   · 如果请求带了 Origin，就核对一下（同源 / 桌面协议 / 回环同端口）。
 */
function trustCheck(req, serverOrigin) {
  if (req.headers[HEADER_MARK] !== '1') return { ok: false, reason: 'missing-mark' };

  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site === 'cross-site') return { ok: false, reason: 'site:cross-site' };

  const origin = req.headers.origin;
  const hasOrigin = typeof origin === 'string' && origin !== '';
  if (!hasOrigin) return { ok: true, reason: 'no-origin' };

  let asked;
  try {
    asked = new URL(origin);
  } catch {
    return { ok: false, reason: `bad-origin:${origin}` };
  }

  // DSH 桌面 app 的页面协议。外部网页无法伪造浏览器自己写的 Origin，所以这一条可信。
  if (asked.protocol === 'dsh-app:') return { ok: true };

  let base;
  try {
    base = new URL(serverOrigin);
  } catch {
    return { ok: false, reason: 'bad-server-origin' };
  }
  if (asked.protocol !== base.protocol) return { ok: false, reason: `proto:${asked.protocol}|${base.protocol}` };
  if (asked.port !== base.port) return { ok: false, reason: `port:${asked.port}|${base.port}` };
  if (asked.hostname === base.hostname) return { ok: true };
  // 监听在 0.0.0.0 / :: 时，页面实际拿的是 127.0.0.1 或 localhost —— 同一台机器、同一个端口就算同源。
  if (LOOPBACK.has(asked.hostname) && LOOPBACK.has(base.hostname)) return { ok: true };
  return { ok: false, reason: `host:${asked.hostname}|${base.hostname}` };
}

function isTrusted(req, serverOrigin) {
  return trustCheck(req, serverOrigin).ok;
}


/* ------------------------------------------------------------ 响应小工具 */

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(body);
}

function methodOf(req) {
  return String(req.method || 'GET').toUpperCase();
}

/* ------------------------------------------------------------ 重启 */

const PUBLIC = 'public';

/**
 * 起 helper。**必须包一层 `cmd /c start /b`**：
 * 实测（2026-10-18）在 Windows 上「powershell.exe + -File + detached:true」会
 * 「启动 → 立刻 exit 0 → 脚本一行都没执行」，日志和报告都不出来，按钮看起来毫无反应。
 * 去掉 detached 就正常，但那样 helper 活不过宿主被停掉。
 * 折中：让 cmd 去建进程（`start /b` 立即返回），helper 作为独立进程继续跑，
 * 宿主这边 unref 后立刻得到返回。代价是这里拿到的 pid 是 cmd 的，不是 helper 的。
 */
function spawnHelper(info) {
  const script = fileURLToPath(new URL('./relaunch.ps1', import.meta.url));
  // cwd 必须真实存在，否则 spawn 会 ENOENT —— 第一次点的时候状态目录往往还没建。
  try { mkdirSync(info.stateDir, { recursive: true }); } catch { /* 下面写文件时还会再试一次 */ }

  const psArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-CallerPid', String(info.callerPid),
    '-StateDir', info.stateDir,
    '-DelaySeconds', String(info.delaySeconds),
  ];

  const child = spawn('cmd.exe', ['/c', 'start', '', '/b', 'powershell.exe', ...psArgs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: info.stateDir,
    env: { ...process.env, DSH_RESTART_DOCK: String(info.id) },
  });
  child.unref();
  return child.pid;
}

export function apply(ctx, config = {}) {
  const cfg = config || {};
  const delaySeconds = Number.isFinite(cfg.delaySeconds) ? Math.max(1, cfg.delaySeconds) : 2;
  const dir = stateDir();

  /** 正在排程/等待的那次重启（防连点）。进程重启后自然清空。 */
  let inFlight = null;
  let acceptedAt = 0;

  const startedAt = Date.now();

  function statusPayload() {
    const last = readJson(join(dir, 'last.json'));
    const pending = readJson(join(dir, 'pending.json'));
    return {
      ok: true,
      dock: {
        version: PUBLIC,
        pid: process.pid,
        platform: process.platform,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        stateDir: dir,
      },
      restart: {
        supported: process.platform === 'win32',
        inFlight: inFlight !== null,
        // 上次 helper 留下的报告（成功/失败/为什么）。新宿主起来后就能读到。
        last: last ?? null,
        // 还没执行完的排程（点击后到 helper 动手之间会看到）。
        pending: pending ?? null,
      },
    };
  }

  async function onStatus(req, res, webServer) {
    if (methodOf(req) !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
    let serverOrigin = '';
    try {
      serverOrigin = webServer.getOrigin();
    } catch {
      serverOrigin = '';
    }
    const trust = trustCheck(req, serverOrigin);
    if (!serverOrigin || !trust.ok) {
      return json(res, 403, {
        ok: false,
        error: 'forbidden',
        reason: serverOrigin ? trust.reason : 'no-server-origin',
      });
    }
    return json(res, 200, statusPayload());
  }

  async function onRestart(req, res, webServer) {
    if (methodOf(req) !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });

    let serverOrigin = '';
    try {
      serverOrigin = webServer.getOrigin();
    } catch {
      serverOrigin = '';
    }
    const trust = trustCheck(req, serverOrigin);
    if (!serverOrigin || !trust.ok) {
      return json(res, 403, {
        ok: false,
        error: 'forbidden',
        reason: serverOrigin ? trust.reason : 'no-server-origin',
      });
    }

    if (process.platform !== 'win32') {
      return json(res, 501, {
        ok: false,
        error: 'unsupported-platform',
        detail: '这个版本只实现了 Windows 的重启；刷新页面在任何平台都能用。',
      });
    }

    // 防连点，但**必须会过期**：helper 可能启动失败、或卡在杀进程那一步没真正重启，
    // 那样宿主还活着，这个标记就会永远卡着，之后点「重启」一律 409，看起来像按钮坏了。
    // 整个重启最长可能走「延迟 + 等停 20s + 补刀 8s + 拉起 40s」≈ 70 秒，
    // 所以过期时间给到「延迟 + 120 秒」，别在流程还没走完时把锁放掉。
    const STALE_MS = (delaySeconds + 120) * 1000;
    if (inFlight && Date.now() - inFlight.startedAtMs < STALE_MS) {
      return json(res, 409, {
        ok: false,
        error: 'already-scheduled',
        detail: '已经有一次重启在路上了，别连点。',
        inFlight: { id: inFlight.id, helperPid: inFlight.helperPid, delaySeconds: inFlight.delaySeconds },
      });
    }
    inFlight = null;

    const id = `rd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      at: new Date().toISOString(),
      callerPid: process.pid,
      hostPid: process.pid,
      delaySeconds,
      requestedBy: String(req.headers.origin || ''),
    };

    writeJson(join(dir, 'pending.json'), record);

    let helperPid;
    try {
      helperPid = spawnHelper({ id, callerPid: process.pid, stateDir: dir, delaySeconds });
    } catch (error) {
      writeJson(join(dir, 'last.json'), {
        ok: false,
        at: new Date().toISOString(),
        id,
        error: 'spawn-failed',
        detail: String(error && error.message ? error.message : error),
      });
      return json(res, 500, { ok: false, error: 'spawn-failed', detail: String(error && error.message ? error.message : error) });
    }

    acceptedAt = Date.now();
    inFlight = { id, helperPid, at: record.at, delaySeconds, startedAtMs: acceptedAt };
    writeJson(join(dir, 'pending.json'), { ...record, helperPid });

    return json(res, 202, {
      ok: true,
      id,
      helperPid,
      delaySeconds,
      detail: '已排程：约 1~2 秒后宿主会停下并重新拉起，界面会断开几秒。',
    });
  }

  /**
   * 插件包健康检查：告诉界面「现在刷新安不安全」。
   *
   * 判据：clientModules 记录的基线（打包前读到的那一代文件的 mtime/ctime/size）
   * 和磁盘上的实际文件比 —— 不一致，说明文件改了但还没重新打包。
   * 这个窗口里刷新会拿到坏包（import failed → 整个 web boot 起不来），
   * 2026-10-18 21:37 就是这么把应用刷崩、只能手动重启的。
   */
  async function onBundleReady(req, res, webServer, getClientModules) {
    if (methodOf(req) !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });

    let serverOrigin = '';
    try {
      serverOrigin = webServer.getOrigin();
    } catch {
      serverOrigin = '';
    }
    const trust = trustCheck(req, serverOrigin);
    if (!serverOrigin || !trust.ok) {
      return json(res, 403, {
        ok: false,
        error: 'forbidden',
        reason: serverOrigin ? trust.reason : 'no-server-origin',
      });
    }

    const cm = getClientModules();
    if (!cm || typeof cm.artifactBaseline !== 'function') {
      // 拿不到 clientModules 就保守放行 —— 这个接口只做提示，不阻断用户。
      return json(res, 200, { ok: true, ready: true, detail: 'no-client-modules' });
    }

    let ready = true;
    let detail = 'stable';
    let syntax = 'skipped';
    try {
      const base = cm.artifactBaseline(name);
      if (!base || !base.path) {
        detail = 'no-baseline';
      } else {
        const st = statSync(base.path);
        const changed = st.mtimeMs !== base.mtimeMs || st.ctimeMs !== base.ctimeMs || st.size !== base.size;
        ready = !changed;
        detail = changed ? 'rebuilding' : 'stable';
      }
    } catch (error) {
      detail = 'stat-failed';
    }

    // 第二道：光看时间戳不够 —— HMR 可能「重建已完成、但产出的包本身是坏的」，
    // 这种包时间戳正常却一加载就 import failed（2026-10-18 21:41 实测，保护没拦住）。
    // 所以把当前 bundle 取出来，用 new Function 干跑一遍语法检查；编译不过就不让刷。
    try {
      if (typeof cm.graph === 'function' && typeof cm.fetchBundle === 'function') {
        const graph = cm.graph();
        const entry = graph && graph.entries ? graph.entries.find((e) => e.id === name) : null;
        if (entry && entry.rev) {
          const url = `http://dsh-restart-dock.local/plugins/??${encodeURIComponent(name)}/client.js&rev=${entry.rev}`;
          const bundleRes = await cm.fetchBundle(new Request(url));
          if (!bundleRes || !bundleRes.ok) {
            syntax = 'fetch-failed';
          } else {
            const text = await bundleRes.text();
            if (!text || text.length < 200) {
              syntax = 'too-short';
              ready = false;
              detail = 'bundle-too-short';
            } else {
              try {
                // 只编译不执行：能过说明语法是好的
                new Function(text);
                syntax = 'ok';
              } catch (compileError) {
                syntax = 'syntax-error';
                ready = false;
                detail = 'bundle-syntax-error';
              }
            }
          }
        }
      }
    } catch (error) {
      syntax = 'check-failed';
    }

    return json(res, 200, { ok: true, ready, detail, syntax });
  }

  // webServer 可能在 apply 那一刻还没挂上，所以用 ctx.inject 等它就位再注册。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (host) => {
        const webServer = host.webServer;
        // clientModules 是可选服务：拿不到就让接口报 unknown，不阻断其它路由。
        const getClientModules = () => {
          try {
            return typeof host.get === 'function' ? host.get('clientModules') : undefined;
          } catch {
            return undefined;
          }
        };

        host.effect(() => webServer.register({
          kind: 'exact',
          path: ROUTE_STATUS,
          handler: (req, res) => onStatus(req, res, webServer),
        }, 'dsh-restart-dock: status route'));

        host.effect(() => webServer.register({
          kind: 'exact',
          path: ROUTE_RESTART,
          handler: (req, res) => onRestart(req, res, webServer),
        }, 'dsh-restart-dock: restart route'));

        host.effect(() => webServer.register({
          kind: 'exact',
          path: ROUTE_BUNDLE,
          handler: (req, res) => onBundleReady(req, res, webServer, getClientModules),
        }, 'dsh-restart-dock: bundle health route'));
      });
    }
  } catch {
    /* 没有 web server 的表面：小框不出现，其它一切不变 */
  }
}
