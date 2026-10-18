/**
 * dsh-restart-dock · 客户端半 —— 界面上的那个小框。
 *
 * 两个动作：
 *   · **重启 DSH** —— 连点两次确认后，POST 给宿主半，由它起一个脱离宿主的 helper 去「停 + 拉」。
 *     点完会自己轮询 `/status`：先确认宿主真的停过（连不上），再等到它回来（又连上）→ 自动刷新。
 *   · **刷新页面** —— `location.reload()`，纯前端，任何平台都行。
 *
 * 位置：整块都能拖（按住走一段就变成拖动，松手贴边）。收起后那个小圆点也一样能拖。
 * 位置存在 localStorage，刷新/重启都在原处。座位是 `shell.overlay`（整框浮动层，不占布局）。
 *
 * 兜底：外面包一层错误边界 —— 这个组件自己出问题时**只让小框消失**，
 * 不让一个装饰性的浮层把整个界面拖下水。
 */

window.__ModuleLoader__.load({
  id: 'dsh-restart-dock',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { Component, useCallback, useEffect, useRef, useState } = React;

    const NS = 'dsh-restart-dock';
    const BASE = '/dsh-restart-dock';
    const MARK = { 'x-dsh-restart-dock': '1' };
    const STORE_COLLAPSED = 'dsh-restart-dock:collapsed';
    const STORE_POS = 'dsh-restart-dock:pos';

    const EDGE = 48;      // 离边多近算「贴边」
    const EDGE_GAP = 6;   // 贴边后留的缝
    const MIN_DRAG = 6;   // 超过这么多像素才算拖动，不是点击

    const ZH = {
      restart: '重启',
      reload: '刷新',
      confirm: '确认重启？',
      cancel: '取消',
      sending: '正在排程…',
      restarting: '正在重启，等它回来…',
      waiting: '宿主已停，等新的起来…',
      slow: '比预期久，可能没起来。可以点「刷新」，起不来就用救援脚本。',
      done: '回来了，正在刷新…',
      reloading: '正在刷新…',
      pkgNotReady: '插件包还在重建，等几秒再刷新（这次没刷，怕刷成起不来的样子）',
      lastOk: '上次重启：成功',
      lastFail: '上次重启：失败',
      collapse: '收起（收起后也能拖）',
      expand: '重启 / 刷新',
      dragHint: '按住可拖动',
      restartHint: '重启=停掉 DSH 再拉起（会断开几秒）；刷新=只重载当前页面。',
      forbidden: '被拒绝：不是同一个界面发来的请求。',
      unsupported: '这个平台暂不支持一键重启，请用「刷新」。',
      failed: '重启没成功',
      ask: '什么时候重启？',
      now: '立即',
      after30: '30 秒',
      after60: '60 秒',
      after120: '2 分钟',
      countdown: (n) => `${n} 秒后重启`,
      abort: '取消重启',
    };

    const EN = {
      restart: 'Restart',
      reload: 'Reload',
      confirm: 'Confirm?',
      cancel: 'Cancel',
      sending: 'Scheduling…',
      restarting: 'Restarting, waiting for it…',
      waiting: 'Host is down, waiting for the new one…',
      slow: 'Taking longer than expected. Try Reload; if it never comes back use the rescue script.',
      done: 'Back — reloading…',
      reloading: 'Reloading…',
      pkgNotReady: 'Plugin bundle is still rebuilding — wait a few seconds and try again (skipped, so the page stays usable)',
      lastOk: 'Last restart: OK',
      lastFail: 'Last restart: failed',
      collapse: 'Collapse (still draggable)',
      expand: 'Restart / Reload',
      dragHint: 'Hold to drag',
      restartHint: 'Restart stops and relaunches DSH (a few seconds offline). Reload only refreshes this page.',
      forbidden: 'Refused: not the same page origin.',
      unsupported: 'One-click restart is Windows-only here; use Reload.',
      failed: 'Restart failed',
      ask: 'When to restart?',
      now: 'Now',
      after30: '30s',
      after60: '60s',
      after120: '2 min',
      countdown: (n) => `Restarting in ${n}s`,
      abort: 'Cancel restart',
    };

    function pickLang() {
      try {
        const raw = String((navigator && navigator.language) || 'zh');
        return raw.toLowerCase().indexOf('zh') === 0 ? ZH : EN;
      } catch {
        return ZH;
      }
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), Math.max(min, max));
    }

    /**
     * 位置按「贴哪条边 + 离边多远」记，而不是记绝对坐标。
     * 这样窗口放大/缩小/全屏时，小框自动跟着边框走，不会跑到视口外面看不见。
     */
    function readPos() {
      try {
        const raw = localStorage.getItem(STORE_POS);
        if (!raw) return null;
        const parsed = JSON.parse(raw);

        if (parsed
          && (parsed.side === 'left' || parsed.side === 'right')
          && (parsed.vSide === 'top' || parsed.vSide === 'bottom')
          && Number.isFinite(parsed.dx) && Number.isFinite(parsed.dy)) {
          return { side: parsed.side, dx: parsed.dx, vSide: parsed.vSide, dy: parsed.dy };
        }

        // 兼容旧格式（绝对 left/top）：换算成最近的边。
        if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
          const W = (typeof window !== 'undefined' && window.innerWidth) || 1280;
          const H = (typeof window !== 'undefined' && window.innerHeight) || 800;
          const w = 150;
          const ht = 44;
          const distLeft = parsed.left;
          const distRight = W - (parsed.left + w);
          const distTop = parsed.top;
          const distBottom = H - (parsed.top + ht);
          return {
            side: distRight <= distLeft ? 'right' : 'left',
            dx: Math.max(4, Math.round(distRight <= distLeft ? distRight : distLeft)),
            vSide: distBottom <= distTop ? 'bottom' : 'top',
            dy: Math.max(4, Math.round(distBottom <= distTop ? distBottom : distTop)),
          };
        }
      } catch { /* 读不到就用默认位置 */ }
      return null;
    }

    function writePos(pos) {
      try { localStorage.setItem(STORE_POS, JSON.stringify(pos)); } catch { /* 忽略 */ }
    }

    function defaultPos() {
      // 默认贴右上角。
      return { side: 'right', dx: 14, vSide: 'top', dy: 112 };
    }

    /** 把一块矩形换算成「最近的边 + 距离」。 */
    function toAnchor(left, top, width, height) {
      const W = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const H = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const distLeft = Math.max(0, left);
      const distRight = Math.max(0, W - (left + width));
      const distTop = Math.max(0, top);
      const distBottom = Math.max(0, H - (top + height));

      // 离边 48px 内直接吸上去
      let side = distRight <= distLeft ? 'right' : 'left';
      let dx = Math.round(Math.min(distLeft, distRight));
      if (Math.min(distLeft, distRight) < EDGE) dx = EDGE_GAP;

      let vSide = distBottom <= distTop ? 'bottom' : 'top';
      let dy = Math.round(Math.min(distTop, distBottom));
      if (Math.min(distTop, distBottom) < EDGE) dy = EDGE_GAP;

      return {
        side,
        dx: Math.max(EDGE_GAP, dx),
        vSide,
        dy: Math.max(EDGE_GAP, dy),
      };
    }

    const CSS = `
.rd-wrap { position: fixed; z-index: 60; display: flex; align-items: center;
  font-size: 12px; line-height: 1; touch-action: none; user-select: none;
  -webkit-user-select: none; cursor: grab; }
.rd-wrap.rd-dragging { cursor: grabbing; }
.rd-wrap.rd-dragging .rd-card, .rd-wrap.rd-dragging .rd-dot { opacity: 1; }
.rd-card { display: flex; align-items: center; gap: 6px; padding: 6px;
  border-radius: 11px; border: 1px solid rgba(128,128,128,.32);
  background: rgba(128,128,128,.12); color: inherit;
  box-shadow: 0 6px 22px rgba(0,0,0,.16); backdrop-filter: blur(8px);
  opacity: .78; transition: opacity .15s ease; }
.rd-card:hover { opacity: 1; }
.rd-btn { font: inherit; font-size: 12px; line-height: 1; padding: 7px 10px; border-radius: 7px;
  cursor: pointer; border: 1px solid rgba(128,128,128,.35);
  background: rgba(128,128,128,.08); color: inherit; white-space: nowrap; }
.rd-btn:hover { background: rgba(128,128,128,.2); }
.rd-btn:disabled { opacity: .45; cursor: default; }
.rd-btn.rd-warn { border-color: rgba(210,153,34,.6); color: #d29922; }
.rd-btn.rd-warn:hover { background: rgba(210,153,34,.16); }
.rd-btn.rd-danger { border-color: rgba(248,81,73,.65); background: rgba(248,81,73,.14); color: #f85149; }
.rd-msg { font-size: 11px; opacity: .72; max-width: 180px; }
.rd-count { font-variant-numeric: tabular-nums; opacity: .9; }
.rd-dot { width: 30px; height: 30px; padding: 0; border-radius: 999px; display: flex;
  align-items: center; justify-content: center; font-size: 13px; }
.rd-dot-wrap { display: flex; align-items: center; }
.rd-tip { position: absolute; right: 0; top: calc(100% + 6px); white-space: nowrap;
  font-size: 11px; padding: 5px 8px; border-radius: 7px; pointer-events: none;
  background: rgba(30,30,32,.94); color: #eee; opacity: 0; transition: opacity .12s; }
.rd-wrap:hover .rd-tip { opacity: 1; }
.rd-fx { position: fixed; inset: 0; width: 100vw; height: 100vh;
  pointer-events: none; z-index: 9999; }
`;

    function Dock() {
      const T = useRef(pickLang()).current;
      const wrapRef = useRef(null);
      const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem(STORE_COLLAPSED) === '1'; } catch { return false; }
      });
      const [pos, setPos] = useState(() => readPos() || defaultPos());
      const [dragging, setDragging] = useState(false);
      const [phase, setPhase] = useState('idle'); // idle | sending | restarting | slow
      const [asking, setAsking] = useState(false);   // 正在问「什么时候重启」
      const [countdown, setCountdown] = useState(null); // 倒计时秒数，null = 没在倒数
      const [note, setNote] = useState('');
      const [last, setLast] = useState(null);

      const armTimer = useRef(null);      // 保留：旧逻辑清理用
      const countdownTimer = useRef(null);
      const restartRef = useRef(null);    // 最新的 doRestart，给倒计时回调调用
      const pollTimer = useRef(null);
      const sawDown = useRef(false);
      const startedAt = useRef(0);
      const alive = useRef(true);
      const drag = useRef(null);       // 进行中的拖动
      const lastDragAt = useRef(0);    // 最近一次拖动结束的时刻（用来吞掉误触的 click）

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
          if (armTimer.current) clearTimeout(armTimer.current);
          if (countdownTimer.current) clearInterval(countdownTimer.current);
          if (pollTimer.current) clearTimeout(pollTimer.current);
        };
      }, []);

      // 拖动过程中用绝对 left/top（手感直接），松手后换算成「贴边 + 距离」。
      // resize 时不需要重算：锚点是相对边的，窗口怎么变它都跟着走。
      const [dragBox, setDragBox] = useState(null);

      /* ---------------- 粒子特效（给用户看的反馈） ---------------- */

      // 点「刷新」时页面会瞬间被替换掉，什么都没发生的样子。
      // 所以先播一段从左上角洒向右下角的粒子，约 0.9 秒，播完再真正刷新。
      const [fxOn, setFxOn] = useState(false);
      const fxEndRef = useRef(null);
      const fxCanvasRef = useRef(null);

      const playFx = useCallback((after) => {
        fxEndRef.current = typeof after === 'function' ? after : null;
        setFxOn(true);
      }, []);

      // 调试入口：**不刷新页面**也能放一次特效。
      // 加它是因为「点刷新看特效」会把 bundle 缓存撞坏（文件变了 rev 没变 →
      // import failed → 整个 web boot 起不来）。以后验特效只调这个钩子。
      useEffect(() => {
        const trigger = () => playFx();
        window.__dshRestartDockFx = trigger;
        return () => {
          if (window.__dshRestartDockFx === trigger) delete window.__dshRestartDockFx;
        };
      }, [playFx]);

      useEffect(() => {
        if (!fxOn) return undefined;
        const canvas = fxCanvasRef.current;
        if (!canvas) { setFxOn(false); return undefined; }
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = window.innerWidth;
        const H = window.innerHeight;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        const ctx = canvas.getContext('2d');
        if (!ctx) { setFxOn(false); return undefined; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const DURATION = 2000;   // 2 秒一道浪

        // 经典「粒子海」做法：整屏铺一层点阵，每个点的亮度由**同一个正弦波**
        // 在它那个位置的相位决定 —— 波峰处的点亮起、变大，波谷处的点暗下去。
        // 波沿屏幕对角线（左上 → 右下）推进，看到的就是几道斜向亮带在扫。
        // 这样整片屏幕都在响应同一道波，而不是我随手摆一堆点。
        const diag = Math.hypot(W, H);
        const dirX = W / diag;
        const dirY = H / diag;
        const TAU = Math.PI * 2;

        const STEP = 22;      // 点阵间距（px）：间距越大越稀
        const KEEP = 0.22;    // 再随机丢掉大部分点，留出「稀树星空」的感觉
        const parts = [];
        for (let y = -STEP; y < H + STEP; y += STEP) {
          for (let x = -STEP; x < W + STEP; x += STEP) {
            if (Math.random() > KEEP) continue;
            parts.push({
              x: x + (Math.random() - 0.5) * STEP * 0.9,
              y: y + (Math.random() - 0.5) * STEP * 0.9,
              // 沿对角线方向的投影 = 波相位的空间部分
              s: (x * dirX + y * dirY) / diag,
              jitter: 0.55 + Math.random() * 0.45,
              hue: 194 + Math.random() * 42,
            });
          }
        }

        let raf = 0;
        let finished = false;
        const begin = performance.now();

        const frame = (now) => {
          if (finished) return;
          const t = Math.min(1, (now - begin) / DURATION);

          if (t >= 1) {
            finished = true;
            ctx.clearRect(0, 0, W, H);
            const cb = fxEndRef.current;
            fxEndRef.current = null;
            setFxOn(false);
            if (typeof cb === 'function') cb();
            return;
          }

          ctx.clearRect(0, 0, W, H);
          ctx.globalCompositeOperation = 'lighter';

          const travel = t * 3;

          for (const q of parts) {
            const phase = q.s * TAU * 2.2 - travel * TAU * 0.55;

            // 三层正弦叠加：主浪 + 两道碎浪。单层是「规则的条纹」，
            // 叠起来才有真实海面那种长短不齐的碎浪感。
            const wave =
              Math.sin(phase) * 0.62 +
              Math.sin(phase * 1.93 + 1.7) * 0.26 +
              Math.sin(phase * 0.47 + 3.1) * 0.12;

            if (wave <= 0) continue;                       // 只画波峰那半边

            const lum = Math.pow(wave, 1.9) * q.jitter;
            if (lum <= 0.02) continue;

            const depth = 0.75 + q.s * 0.55;               // 右下角稍大，给点纵深
            const size = (1.1 + lum * 6.4) * depth;

            // 波峰越亮越偏白，波坡偏蓝。
            const light = 58 + lum * 38;

            // 蓝色十字星星：一横一竖 + 中心亮点，越亮臂越长。
            const arm = size * (1.7 + lum * 1.7);
            const thick = Math.max(1.0, size * 0.46);

            // 交叉处的柔光
            if (lum > 0.35) {
              ctx.globalAlpha = Math.min(0.34, lum * 0.3);
              ctx.fillStyle = `hsl(${q.hue} 100% 78%)`;
              ctx.beginPath();
              ctx.arc(q.x, q.y, arm * 0.85, 0, TAU);
              ctx.fill();
            }

            ctx.globalAlpha = Math.min(1, lum * 1.75);
            ctx.fillStyle = `hsl(${q.hue} 96% ${light}%)`;
            // 横臂
            ctx.fillRect(q.x - arm, q.y - thick / 2, arm * 2, thick);
            // 竖臂
            ctx.fillRect(q.x - thick / 2, q.y - arm, thick, arm * 2);
            // 中心亮核
            ctx.beginPath();
            ctx.arc(q.x, q.y, thick * 1.15, 0, TAU);
            ctx.fill();
          }

          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
          raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);

        return () => {
          finished = true;
          cancelAnimationFrame(raf);
        };
      }, [fxOn]);

      /* ---------------- 拖动 ---------------- */

      const onPointerDown = useCallback((event) => {
        if (event.button !== 0) return;
        const el = wrapRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        drag.current = {
          id: event.pointerId,
          sx: event.clientX,
          sy: event.clientY,
          bl: rect.left,
          bt: rect.top,
          moved: false,
        };
        // **不要在这里 setPointerCapture**。实测（2026-10-18）它会把后续 pointer 事件
        // 全部捕获到这个元素上，导致「真实鼠标点击」的 click 根本不触发 ——
        // 表现就是小框渲染正常、elementFromPoint 也命中按钮，但怎么点都没反应，
        // 而编程 element.click() 却是好的。capture 推迟到确认开始拖动时再做。
      }, []);

      const onPointerMove = useCallback((event) => {
        const d = drag.current;
        if (!d || d.id !== event.pointerId) return;
        const dx = event.clientX - d.sx;
        const dy = event.clientY - d.sy;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) < MIN_DRAG) return;
        if (!d.moved) {
          d.moved = true;
          setDragging(true);
          // 确认是在拖了才捕获指针 —— 这样普通点击不会被捕获吞掉。
          try { wrapRef.current?.setPointerCapture(d.id); } catch { /* 老浏览器忽略 */ }
        }
        const el = wrapRef.current;
        const w = el ? el.offsetWidth : 150;
        const ht = el ? el.offsetHeight : 44;
        setDragBox({
          left: clamp(d.bl + dx, 4, ((window.innerWidth || 1280) - w - 4)),
          top: clamp(d.bt + dy, 4, ((window.innerHeight || 800) - ht - 4)),
        });
        event.preventDefault();
      }, []);

      const finishDrag = useCallback((event) => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        try { wrapRef.current?.releasePointerCapture(d.id); } catch { /* 忽略 */ }
        if (!d.moved) {
          setDragBox(null);
          return;
        }
        setDragging(false);
        lastDragAt.current = Date.now();
        // 松手：把拖到的地方换算成「贴哪条边 + 离边多远」。
        const el = wrapRef.current;
        const w = el ? el.offsetWidth : 150;
        const ht = el ? el.offsetHeight : 44;
        setDragBox((box) => {
          if (box) {
            const next = toAnchor(box.left, box.top, w, ht);
            writePos(next);
            setPos(next);
          }
          return null;
        });
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
      }, []);

      /** 拖动刚结束的那一下点击要吞掉，否则一拖就会顺手触发按钮。 */
      const swallowAfterDrag = useCallback(() => Date.now() - lastDragAt.current < 180, []);

      const onButtonClick = useCallback((fn) => (event) => {
        if (swallowAfterDrag()) {
          try { event.preventDefault(); event.stopPropagation(); } catch { /* 忽略 */ }
          return;
        }
        fn();
      }, [swallowAfterDrag]);

      const rememberCollapsed = useCallback((next) => {
        setCollapsed(next);
        try { localStorage.setItem(STORE_COLLAPSED, next ? '1' : '0'); } catch { /* 忽略 */ }
      }, []);

      /* ---------------- 宿主交互 ---------------- */

      // 首次读一眼上次重启的报告（不影响主流程）。
      useEffect(() => {
        let stop = false;
        (async () => {
          try {
            const res = await fetch(BASE + '/status', { headers: MARK, cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (!stop && data && data.restart) setLast(data.restart.last || null);
          } catch { /* 宿主刚起/还没路由，忽略 */ }
        })();
        return () => { stop = true; };
      }, []);

      const pollUntilBack = useCallback(() => {
        const tick = async () => {
          if (!alive.current) return;
          try {
            const res = await fetch(BASE + '/status', { headers: MARK, cache: 'no-store' });
            if (res.ok) {
              if (sawDown.current) {
                // 宿主真的停过又回来了：自动刷新，用户不用自己按。
                setPhase('restarting');
                setNote(T.done);
                try { window.location.reload(); } catch { /* 忽略 */ }
                return;
              }
            } else {
              sawDown.current = true;
            }
          } catch {
            sawDown.current = true;
          }
          if (sawDown.current) setNote(T.waiting);
          // 整个重启最长可能走 70 秒左右（等停 + 补刀 + 拉起轮询），
          // 所以放弃阈值给到 90 秒 —— 别在它还好好地重启时先说"比预期久"。
          if (Date.now() - startedAt.current > 90000) {
            setPhase('slow');
            setNote(T.slow);
            return;
          }
          pollTimer.current = setTimeout(tick, 900);
        };
        tick();
      }, [T]);

      const doRestart = useCallback(async () => {
        if (phase === 'sending' || phase === 'restarting') return;
        setPhase('sending');
        setNote(T.sending);
        try {
          const res = await fetch(BASE + '/restart', {
            method: 'POST',
            headers: MARK,
            cache: 'no-store',
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            setPhase('idle');
            if (res.status === 403) setNote(T.forbidden);
            else if (res.status === 501) setNote(T.unsupported);
            else if (res.status === 409) setNote(data.detail || T.restarting);
            else setNote(T.failed + (data.detail ? '：' + data.detail : ''));
            return;
          }
          startedAt.current = Date.now();
          setPhase('restarting');
          setNote(T.restarting);
          playFx();          // 让「正在重启」有个看得见的起手
          pollUntilBack();
        } catch {
          setPhase('idle');
          setNote(T.failed);
        }
      }, [phase, T, pollUntilBack, playFx]);

      // 倒计时的回调里要调用「最新那一版」doRestart，不能用闭包里过期的。
      restartRef.current = doRestart;

      /**
       * 点「重启」不再直接干，先问一句「什么时候」：
       * 立即 / 30 秒 / 60 秒 / 2 分钟 / 取消。
       * 选延迟就在界面上倒计时，随时能撤回 —— 给自己留个反悔的窗口。
       */
      const openAsk = useCallback(() => {
        if (phase === 'sending' || phase === 'restarting') return;
        setAsking((cur) => !cur);
        setNote(T.ask);
      }, [phase, T]);

      // 问询框开出来之后，几秒不操作就自己收回去 —— 别让它一直占着屏幕。
      // 选任一选项（立即/30s/…）或点「取消」都会把 asking 置 false，cleanup 顺手清掉定时器。
      useEffect(() => {
        if (!asking) return undefined;
        const t = setTimeout(() => {
          setAsking(false);
          setNote('');
        }, 5000);
        return () => clearTimeout(t);
      }, [asking]);

      const startCountdown = useCallback((seconds) => {
        setAsking(false);
        if (countdownTimer.current) clearInterval(countdownTimer.current);
        setCountdown(seconds);
        countdownTimer.current = setInterval(() => {
          setCountdown((cur) => {
            if (cur === null) return null;
            if (cur <= 1) {
              if (countdownTimer.current) {
                clearInterval(countdownTimer.current);
                countdownTimer.current = null;
              }
              // 用 ref 拿最新的 doRestart，避开闭包过期
              const fire = restartRef.current;
              setNote('');
              if (fire) fire();
              return null;
            }
            return cur - 1;
          });
        }, 1000);
      }, []);

      const abortCountdown = useCallback(() => {
        if (countdownTimer.current) {
          clearInterval(countdownTimer.current);
          countdownTimer.current = null;
        }
        setCountdown(null);
        setAsking(false);
        setNote('');
      }, []);

      const doReload = useCallback(async () => {
        if (phase === 'sending' || phase === 'restarting' || phase === 'reloading') return;
        // 用独立的 'reloading' 状态：之前复用了 'sending'，导致刷新时按钮写着
        // 「正在排程…」（那是重启的文案），看起来像点错了东西。
        setPhase('reloading');
        setNote(T.reloading);

        // 刷新前先问宿主：插件包现在稳不稳。
        // 为什么：client 插件包是按需拼的，本地文件刚改过会有一小段「重建中」；
        // 这个窗口里刷新会拿到坏包 → import failed → 整个 web boot 起不来
        // （2026-10-18 21:37 就是这么刷崩的，只能手动重启）。
        // 宿主侧用 clientModules 的文件基线对比磁盘，能准确判断这个窗口。
        let ready = true;
        try {
          const res = await fetch(BASE + '/bundle-ready', { headers: MARK, cache: 'no-store' });
          if (res.ok) {
            const data = await res.json().catch(() => null);
            if (data && data.ready === false) ready = false;
          }
        } catch {
          ready = true; // 查不到就放行，不拿接口故障阻断用户
        }

        if (!ready) {
          setPhase('idle');
          setNote(T.pkgNotReady);
          return;
        }

        // 页面一刷新就什么都没了，所以先把粒子播完（约 2 秒）再 reload。
        playFx(() => {
          try {
            // **不要把 location.reload() 当成安全操作**。
            // 对照实验（2026-10-18）：页面稳定的情况下，强制刷新 / 普通刷新 /
            // 页面内 reload 都不会崩；但「刚改完 client.js 不久」再刷新，
            // 会拿到页面自己记的旧版本包 → import failed → 整个 web boot 起不来。
            // 所以这里带一个时间戳参数强制走新 URL，绕开页面级缓存。
            const u = new URL(window.location.href);
            u.searchParams.set('_dsh_r', String(Date.now()));
            window.location.replace(u.toString());
          } catch {
            try { window.location.reload(); } catch { setPhase('idle'); }
          }
        });
      }, [phase, T, playFx]);

      /* ---------------- 渲染 ---------------- */

      const busy = phase === 'sending' || phase === 'restarting' || phase === 'reloading';
      // 只有明确「拉起来了」才算成功；failed 才算失败；armed/dry-run 之类不表态。
      const lastText = last
        ? (last.state === 'relaunched' ? T.lastOk : (last.state === 'failed' ? T.lastFail : ''))
        : '';

      // 拖动中用绝对坐标；平时用「贴边 + 距离」，窗口缩放/全屏都自动跟着边框走。
      const wrapStyle = dragBox
        ? { left: dragBox.left + 'px', top: dragBox.top + 'px' }
        : {
          ...(pos.side === 'right' ? { right: pos.dx + 'px' } : { left: pos.dx + 'px' }),
          ...(pos.vSide === 'bottom' ? { bottom: pos.dy + 'px' } : { top: pos.dy + 'px' }),
        };

      const wrapProps = {
        ref: wrapRef,
        className: 'rd-wrap' + (dragging ? ' rd-dragging' : ''),
        style: wrapStyle,
        onPointerDown,
        onPointerMove,
        onPointerUp: finishDrag,
        onPointerCancel: finishDrag,
      };

      // 粒子画布是整屏 fixed 的，挂在哪个分支里都一样；只在播放时存在。
      const fxCanvas = fxOn ? h('canvas', { className: 'rd-fx', ref: fxCanvasRef }) : null;

      if (collapsed) {
        return h('div', wrapProps,
          h('style', null, CSS),
          fxCanvas,
          h('button', {
            type: 'button',
            className: 'rd-btn rd-dot',
            title: lastText || T.expand,
            'aria-label': T.expand,
            onClick: onButtonClick(() => rememberCollapsed(false)),
          }, '⏻'),
          h('div', { className: 'rd-tip' }, lastText || T.dragHint),
        );
      }

      return h('div', wrapProps,
        h('style', null, CSS),
        fxCanvas,
        h('div', { className: 'rd-card' },
          note ? h('span', { className: 'rd-msg' }, note) : null,

          // 倒计时中：显示还剩几秒，旁边一个撤回。
          countdown !== null
            ? [
              h('span', { key: 'cd', className: 'rd-msg rd-count' }, T.countdown(countdown)),
              h('button', {
                key: 'abort',
                type: 'button',
                className: 'rd-btn rd-danger',
                onClick: onButtonClick(abortCountdown),
              }, T.abort),
            ]
            // 问询中：立即 / 30 秒 / 60 秒 / 2 分钟。
            : asking
              ? [
                h('button', {
                  key: 'now',
                  type: 'button',
                  className: 'rd-btn rd-danger',
                  disabled: busy,
                  onClick: onButtonClick(() => { setAsking(false); setNote(''); doRestart(); }),
                }, T.now),
                h('button', {
                  key: 'a30',
                  type: 'button',
                  className: 'rd-btn',
                  disabled: busy,
                  onClick: onButtonClick(() => startCountdown(30)),
                }, T.after30),
                h('button', {
                  key: 'a60',
                  type: 'button',
                  className: 'rd-btn',
                  disabled: busy,
                  onClick: onButtonClick(() => startCountdown(60)),
                }, T.after60),
                h('button', {
                  key: 'a120',
                  type: 'button',
                  className: 'rd-btn',
                  disabled: busy,
                  onClick: onButtonClick(() => startCountdown(120)),
                }, T.after120),
                h('button', {
                  key: 'cancel',
                  type: 'button',
                  className: 'rd-btn',
                  onClick: onButtonClick(() => { setAsking(false); setNote(''); }),
                }, T.cancel),
              ]
              // 平时：重启 / 刷新 / 收起。
              : [
                h('button', {
                  key: 'restart',
                  type: 'button',
                  className: 'rd-btn rd-warn',
                  disabled: busy,
                  title: lastText || T.restartHint,
                  onClick: onButtonClick(openAsk),
                }, phase === 'sending' ? T.sending : T.restart),
                h('button', {
                  key: 'reload',
                  type: 'button',
                  className: 'rd-btn',
                  disabled: busy,
                  onClick: onButtonClick(doReload),
                }, phase === 'reloading' ? T.reloading : T.reload),
                h('button', {
                  key: 'collapse',
                  type: 'button',
                  className: 'rd-btn',
                  title: T.collapse,
                  'aria-label': T.collapse,
                  onClick: onButtonClick(() => rememberCollapsed(true)),
                }, '×'),
              ],
        ),
        h('div', { className: 'rd-tip' }, lastText || T.dragHint),
      );
    }

    /**
     * 错误边界：这个浮层只是装饰，它炸了不该把整个界面一起带走。
     * 只记一笔、把自己藏起来，让主界面继续工作。
     */
    class Guard extends Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        try {
          // 不往上抛，也不动别人的 DOM —— 留给控制台，用户无感。
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[dsh-restart-dock] 小框渲染失败，已自行隐藏：', error);
          }
        } catch { /* 忽略 */ }
      }

      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    return {
      name: NS,
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-restart-dock',
          order: 900,
        }, function SafeDock() {
          return h(Guard, null, h(Dock));
        }));
      },
    };
  },
});
