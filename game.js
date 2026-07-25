/* ─────────────────────────────────────────────────────────────
   Plasma Cut — game engine (vanilla ES2017, no dependencies)

   Grid model
     COLS x ROWS cells. grid[i]: 0 = open, 1 = solid (wall or
     captured), 2 = wall currently growing (fatal to touch).

   Loop
     step()  advances orbs, wall heads, particles
     draw()  paints the field, including the axis-mode affordances

   Direction UX (sticky mode, no double-tap)
     1. grid lines along the active axis are lit, the other axis fades
     2. the two field edges the wall travels toward pulse
     3. bottom segmented control + a sweep animation on flip
     4. press-and-hold previews the exact span the wall will fill
   ──────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── tunables ───────────────────────────────────────────────
  var COLS = 27, ROWS = 45;      // field resolution in cells
  var MAX_LEVEL = 12;
  var LIVES = 3;
  var WALL_STEP_MS = 14;         // ms per cell of wall growth
  var ACCENT = '#2ee6f6';
  var ORB = '#ff2e8a';
  var SAVE_KEY = 'plasmacut.v1';

  // ── derived layout (recomputed on resize) ──────────────────
  var CELL = 14, W = COLS * CELL, H = ROWS * CELL, R = 6.2, DPR = 1;

  // ── state ──────────────────────────────────────────────────
  var S = {
    screen: 'title',            // title | levels | scores | game | paused | clear | dead
    level: 1, lives: LIVES, pct: 0, score: 0, time: 0,
    axis: 'h', unlocked: 1, best: 0, nickname: ''
  };
  var submitState = 'idle'; // idle | sending | done | error

  var grid, claim, balls, wall, parts;
  var shake = 0, flash = 0, flashColor = ACCENT;
  var press = null, axisFlash = -1e9, acc = 0;
  var t0 = 0, last = 0, pauseAt = 0, raf = null;

  // ── dom ────────────────────────────────────────────────────
  var el = {
    app: document.getElementById('app'),
    title: document.getElementById('screen-title'),
    levels: document.getElementById('screen-levels'),
    scores: document.getElementById('screen-scores'),
    game: document.getElementById('screen-game'),
    levelGrid: document.getElementById('level-grid'),
    scoreboard: document.getElementById('scoreboard'),
    scoreboardStatus: document.getElementById('scoreboard-status'),
    submitPanel: document.getElementById('submit-panel'),
    nicknameInput: document.getElementById('nickname-input'),
    submitMsg: document.getElementById('submit-msg'),
    submitBtn: document.getElementById('btn-submit-score'),
    pips: document.getElementById('pips'),
    barFill: document.getElementById('bar-fill'),
    barTarget: document.getElementById('bar-target'),
    fieldWrap: document.getElementById('field-wrap'),
    canvas: document.getElementById('field'),
    hud: document.querySelector('.hud'),
    dock: document.querySelector('.axis-dock'),
    overlays: {
      paused: document.getElementById('overlay-paused'),
      clear: document.getElementById('overlay-clear'),
      dead: document.getElementById('overlay-dead')
    }
  };
  var ctx = el.canvas.getContext('2d');

  function target() { return Math.min(94, 70 + S.level); }

  // ── persistence ────────────────────────────────────────────
  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
      S.unlocked = raw.unlocked || 1;
      S.best = raw.best || 0;
      S.nickname = typeof raw.nickname === 'string' ? raw.nickname : '';
    } catch (e) { /* private mode */ }
  }
  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        unlocked: S.unlocked,
        best: S.best,
        nickname: S.nickname
      }));
    } catch (e) {}
  }

  // ── leaderboard API ────────────────────────────────────────
  function apiUrl(path) {
    return '/.netlify/functions/' + path;
  }

  function setSubmitMsg(text, kind) {
    if (!text) {
      el.submitMsg.hidden = true;
      el.submitMsg.textContent = '';
      el.submitMsg.className = 'submit-msg';
      return;
    }
    el.submitMsg.hidden = false;
    el.submitMsg.textContent = text;
    el.submitMsg.className = 'submit-msg' + (kind ? ' is-' + kind : '');
  }

  function resetSubmitPanel() {
    submitState = 'idle';
    el.submitPanel.classList.remove('is-done');
    el.submitBtn.disabled = false;
    el.submitBtn.textContent = 'SUBMIT SCORE';
    el.nicknameInput.value = S.nickname || '';
    setSubmitMsg('');
  }

  function renderScoreboard(rows) {
    el.scoreboard.innerHTML = '';
    if (!rows || !rows.length) {
      var empty = document.createElement('p');
      empty.className = 'scoreboard-status';
      empty.textContent = 'NO SCORES YET — CLEAR A LEVEL AND SUBMIT.';
      el.scoreboard.appendChild(empty);
      return;
    }
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var item = document.createElement('div');
      item.className = 'score-row' + (i < 3 ? ' is-top' : '');
      item.innerHTML =
        '<div class="score-rank">' + String(i + 1).padStart(2, '0') + '</div>' +
        '<div class="score-nick"></div>' +
        '<div class="score-meta">' +
          '<div class="score-points"></div>' +
          '<div class="score-level"></div>' +
        '</div>';
      item.querySelector('.score-nick').textContent = row.nickname;
      item.querySelector('.score-points').textContent = Number(row.score).toLocaleString();
      item.querySelector('.score-level').textContent = 'LV ' + String(row.level).padStart(2, '0');
      el.scoreboard.appendChild(item);
    }
  }

  function loadLeaderboard() {
    el.scoreboard.innerHTML = '';
    var status = document.createElement('p');
    status.className = 'scoreboard-status';
    status.id = 'scoreboard-status';
    status.textContent = 'LOADING…';
    el.scoreboard.appendChild(status);

    fetch(apiUrl('leaderboard'))
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) throw new Error((result.data && result.data.error) || 'Failed to load');
        renderScoreboard(result.data.scores || []);
      })
      .catch(function () {
        el.scoreboard.innerHTML = '';
        var err = document.createElement('p');
        err.className = 'scoreboard-status';
        err.textContent = 'COULD NOT LOAD SCORES.';
        el.scoreboard.appendChild(err);
      });
  }

  function submitScore() {
    if (submitState === 'sending' || submitState === 'done') return;
    var nick = (el.nicknameInput.value || '').trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z0-9 _]{2,16}$/.test(nick)) {
      setSubmitMsg('Use 2–16 letters, numbers, spaces, or _', 'error');
      return;
    }

    submitState = 'sending';
    el.submitBtn.disabled = true;
    el.submitBtn.textContent = 'SENDING…';
    setSubmitMsg('');

    fetch(apiUrl('score'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: nick, score: S.score, level: S.level })
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; }); })
      .then(function (result) {
        if (!result.ok) {
          throw new Error((result.data && result.data.error) || 'Submit failed');
        }
        S.nickname = nick;
        save();
        submitState = 'done';
        el.submitPanel.classList.add('is-done');
        if (result.data.updated) setSubmitMsg('Posted to the public board.', 'ok');
        else setSubmitMsg('Your best on the board is already higher.', 'ok');
      })
      .catch(function (err) {
        submitState = 'error';
        el.submitBtn.disabled = false;
        el.submitBtn.textContent = 'SUBMIT SCORE';
        setSubmitMsg(err.message || 'Could not submit score.', 'error');
      });
  }

  // ── layout ─────────────────────────────────────────────────
  function layout() {
    var availW = el.app.clientWidth - 24;
    var hudH = el.hud.offsetHeight || 52;
    var chromeTop = parseFloat(getComputedStyle(el.game).paddingTop) || 8;
    var chromeBot = parseFloat(getComputedStyle(el.game).paddingBottom) || 8;
    var availH = el.app.clientHeight - hudH - chromeTop - chromeBot - 96; // 96 = axis dock

    var next = Math.max(6, Math.floor(Math.min(availW / COLS, availH / ROWS)));
    if (next === CELL && el.canvas.width) return;

    var scale = next / CELL;
    CELL = next; W = COLS * CELL; H = ROWS * CELL; R = CELL * 0.44;
    DPR = Math.min(2, window.devicePixelRatio || 1);

    el.fieldWrap.style.width = W + 'px';
    el.fieldWrap.style.height = H + 'px';
    el.canvas.style.width = W + 'px';
    el.canvas.style.height = H + 'px';
    el.canvas.width = Math.round(W * DPR);
    el.canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    if (balls) for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      b.x *= scale; b.y *= scale; b.vx *= scale; b.vy *= scale; b.tr.length = 0;
    }
  }

  // ── screens ────────────────────────────────────────────────
  function show(screen) {
    S.screen = screen;
    var inGame = screen === 'game' || screen === 'paused' || screen === 'clear' || screen === 'dead';
    el.title.hidden = screen !== 'title';
    el.levels.hidden = screen !== 'levels';
    el.scores.hidden = screen !== 'scores';
    el.game.hidden = !inGame;
    el.overlays.paused.hidden = screen !== 'paused';
    el.overlays.clear.hidden = screen !== 'clear';
    el.overlays.dead.hidden = screen !== 'dead';
    if (screen === 'levels') renderLevels();
    if (screen === 'scores') loadLeaderboard();
    if (screen === 'clear') resetSubmitPanel();
    syncHud();
  }

  function bind(name, value) {
    var nodes = document.querySelectorAll('[data-bind="' + name + '"]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = value;
  }

  function syncHud() {
    var mm = Math.floor(S.time / 60), ss = Math.floor(S.time % 60);
    bind('level', String(S.level).padStart(2, '0'));
    bind('pct', S.pct + '%');
    bind('target', target() + '%');
    bind('score', S.score.toLocaleString());
    bind('best', S.best.toLocaleString());
    bind('time', mm + ':' + String(ss).padStart(2, '0'));
    el.barFill.style.width = S.pct + '%';
    el.barTarget.style.left = target() + '%';
    if (el.pips.children.length !== LIVES) {
      el.pips.innerHTML = '';
      for (var i = 0; i < LIVES; i++) el.pips.appendChild(document.createElement('div')).className = 'pip';
    }
    for (var j = 0; j < LIVES; j++) el.pips.children[j].className = 'pip' + (j < S.lives ? '' : ' is-off');
  }

  function renderLevels() {
    el.levelGrid.innerHTML = '';
    for (var i = 1; i <= MAX_LEVEL; i++) {
      var locked = i > S.unlocked;
      var tile = document.createElement('button');
      tile.className = 'level-tile' + (locked ? ' is-locked' : '');
      tile.innerHTML = '<b>' + String(i).padStart(2, '0') + '</b><span>' +
        (locked ? 'LOCKED' : Math.min(9, i + 1) + ' ORBS') + '</span>';
      if (!locked) tile.dataset.level = i;
      el.levelGrid.appendChild(tile);
    }
  }

  // ── level lifecycle ────────────────────────────────────────
  function startLevel(level, keepScore) {
    S.level = level;
    S.lives = LIVES;
    S.pct = 0;
    S.time = 0;
    if (!keepScore) S.score = 0;

    grid = new Uint8Array(COLS * ROWS);
    claim = new Float64Array(COLS * ROWS);
    balls = [];
    wall = null; parts = []; press = null;
    shake = 0; flash = 0; acc = 0;

    show('game');
    layout();

    var count = Math.min(9, level + 1);
    var speed = (1.5 + level * 0.11) * (CELL / 14);
    for (var i = 0; i < count; i++) {
      var a = Math.PI / 4 + (Math.random() < .5 ? 0 : Math.PI / 2) +
        (Math.random() - .5) * .5 + (Math.random() < .5 ? 0 : Math.PI);
      balls.push({
        x: W * .15 + Math.random() * W * .7,
        y: H * .12 + Math.random() * H * .76,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, tr: []
      });
    }

    t0 = last = performance.now();
    run();
  }

  function run() { stop(); raf = requestAnimationFrame(loop); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = null; }

  function loop(now) {
    var dt = Math.min(3, (now - last) / 16.667);
    last = now;
    step(dt, now);
    draw(now);
    raf = S.screen === 'game' ? requestAnimationFrame(loop) : null;
  }

  // ── simulation ─────────────────────────────────────────────
  function blocked(x, y) {
    if (x - R < 0 || y - R < 0 || x + R > W || y + R > H) return true;
    var c0 = Math.floor((x - R) / CELL), c1 = Math.floor((x + R) / CELL);
    var r0 = Math.floor((y - R) / CELL), r1 = Math.floor((y + R) / CELL);
    for (var r = r0; r <= r1; r++)
      for (var c = c0; c <= c1; c++)
        if (grid[r * COLS + c] === 1) return true;
    return false;
  }

  function step(dt, now) {
    var i, b;

    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      b.tr.push(b.x, b.y);
      if (b.tr.length > 26) b.tr.splice(0, 2);
      var nx = b.x + b.vx * dt;
      if (blocked(nx, b.y)) { b.vx = -b.vx; burst(b.x, b.y, 3, ACCENT, .8); shake = Math.max(shake, 1.2); }
      else b.x = nx;
      var ny = b.y + b.vy * dt;
      if (blocked(b.x, ny)) { b.vy = -b.vy; burst(b.x, b.y, 3, ACCENT, .8); shake = Math.max(shake, 1.2); }
      else b.y = ny;
    }

    if (wall) {
      acc += dt * 16.667;
      while (acc >= WALL_STEP_MS && wall) {
        acc -= WALL_STEP_MS;
        var heads = [wall.a, wall.b];
        for (var k = 0; k < 2; k++) {
          var hd = heads[k];
          if (hd.done) continue;
          var c = hd.c + hd.dc, r = hd.r + hd.dr;
          if (c < 0 || r < 0 || c >= COLS || r >= ROWS || grid[r * COLS + c] !== 0) { hd.done = true; continue; }
          hd.c = c; hd.r = r;
          grid[r * COLS + c] = 2;
          wall.cells.push(r * COLS + c);
        }
        if (wall.a.done && wall.b.done) { solidify(now); break; }
      }
    }

    if (wall) {
      for (i = 0; i < balls.length; i++) {
        b = balls[i];
        if (touchesGrowing(b)) { fail(); break; }
      }
    }

    for (i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= .94; p.vy *= .94;
      p.l -= dt / p.m;
      if (p.l <= 0) parts.splice(i, 1);
    }

    shake *= Math.pow(.86, dt);
    flash *= Math.pow(.9, dt);

    var t = (now - t0) / 1000;
    var tick = Math.floor(t) !== Math.floor(S.time);
    S.time = t;
    if (tick) syncHud();
  }

  function touchesGrowing(b) {
    var c0 = Math.max(0, Math.floor((b.x - R) / CELL)), c1 = Math.min(COLS - 1, Math.floor((b.x + R) / CELL));
    var r0 = Math.max(0, Math.floor((b.y - R) / CELL)), r1 = Math.min(ROWS - 1, Math.floor((b.y + R) / CELL));
    for (var r = r0; r <= r1; r++)
      for (var c = c0; c <= c1; c++)
        if (grid[r * COLS + c] === 2) return true;
    return false;
  }

  function fail() {
    for (var i = 0; i < wall.cells.length; i++) {
      var idx = wall.cells[i];
      grid[idx] = 0;
      if (Math.random() < .3) burst(cx(idx), cy(idx), 2, ORB, 2.2);
    }
    wall = null;
    shake = 14; flash = 1; flashColor = ORB;
    S.lives--;
    if (S.lives <= 0) {
      S.lives = 0;
      if (S.score > S.best) { S.best = S.score; save(); }
      stop(); show('dead');
    }
    syncHud();
  }

  function solidify(now) {
    var i;
    for (i = 0; i < wall.cells.length; i++) { grid[wall.cells[i]] = 1; claim[wall.cells[i]] = now; }
    wall = null;
    shake = Math.max(shake, 4);
    for (i = 0; i < balls.length; i++) balls[i].tr.length = 0; // stale trails would paint over captured cells

    // flood fill: any open region without an orb is captured
    var N = COLS * ROWS;
    var seen = new Uint8Array(N), queue = new Int32Array(N);
    var gained = 0;

    for (var s = 0; s < N; s++) {
      if (grid[s] !== 0 || seen[s]) continue;
      var head = 0, tail = 0, region = [];
      queue[tail++] = s; seen[s] = 1;
      while (head < tail) {
        var idx = queue[head++];
        region.push(idx);
        var c = idx % COLS, r = (idx - c) / COLS;
        if (c > 0 && !seen[idx - 1] && grid[idx - 1] === 0) { seen[idx - 1] = 1; queue[tail++] = idx - 1; }
        if (c < COLS - 1 && !seen[idx + 1] && grid[idx + 1] === 0) { seen[idx + 1] = 1; queue[tail++] = idx + 1; }
        if (r > 0 && !seen[idx - COLS] && grid[idx - COLS] === 0) { seen[idx - COLS] = 1; queue[tail++] = idx - COLS; }
        if (r < ROWS - 1 && !seen[idx + COLS] && grid[idx + COLS] === 0) { seen[idx + COLS] = 1; queue[tail++] = idx + COLS; }
      }
      var holds = false;
      for (i = 0; i < balls.length; i++) {
        var bi = Math.floor(balls[i].y / CELL) * COLS + Math.floor(balls[i].x / CELL);
        if (seen[bi] && region.indexOf(bi) !== -1) { holds = true; break; }
      }
      if (holds) continue;

      for (i = 0; i < region.length; i++) { grid[region[i]] = 1; claim[region[i]] = now + i * 3; }
      gained += region.length;
      var mid = region[region.length >> 1];
      burst(cx(mid), cy(mid), 16, ACCENT, 2.4);
      shake = Math.max(shake, 7);
      flash = .5; flashColor = ACCENT;
    }

    var solid = 0;
    for (i = 0; i < N; i++) if (grid[i] === 1) solid++;
    S.pct = Math.round(solid / N * 100);
    S.score += gained * 8 + (gained ? 60 : 0);

    if (S.pct >= target()) {
      S.score += Math.max(0, 90 - Math.floor(S.time)) * 12 + S.lives * 250;
      S.unlocked = Math.max(S.unlocked, Math.min(MAX_LEVEL, S.level + 1));
      S.best = Math.max(S.best, S.score);
      save();
      stop(); show('clear');
    }
    syncHud();
  }

  function burst(x, y, n, color, spd) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = (.4 + Math.random()) * spd * (CELL / 14);
      parts.push({
        x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        l: 1, m: 14 + Math.random() * 22, c: color, s: (1 + Math.random() * 2) * (CELL / 14)
      });
    }
  }

  function cx(i) { return (i % COLS + .5) * CELL; }
  function cy(i) { return (((i - i % COLS) / COLS) + .5) * CELL; }

  // ── rendering ──────────────────────────────────────────────
  function draw(now) {
    var horiz = S.axis === 'h';
    var i, c, r, x, y;

    ctx.save();
    if (shake > .3) ctx.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake);
    ctx.fillStyle = '#05080f';
    ctx.fillRect(-20, -20, W + 40, H + 40);

    // 1 ─ axis-aware grid: the mode you're in, read straight off the field
    var lit = 'rgba(46,230,246,0.17)', dim = 'rgba(140,200,215,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.strokeStyle = horiz ? lit : dim;
    for (r = 0; r <= ROWS; r++) { ctx.moveTo(0, r * CELL + .5); ctx.lineTo(W, r * CELL + .5); }
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = horiz ? dim : lit;
    for (c = 0; c <= COLS; c++) { ctx.moveTo(c * CELL + .5, 0); ctx.lineTo(c * CELL + .5, H); }
    ctx.stroke();

    // 2 ─ sweep confirming an axis flip
    var af = (now - axisFlash) / 420;
    if (af >= 0 && af < 1) {
      var e = 1 - Math.pow(1 - af, 2);
      ctx.save();
      ctx.globalAlpha = (1 - af) * .8;
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 2;
      ctx.shadowColor = ACCENT; ctx.shadowBlur = 18;
      ctx.beginPath();
      if (horiz) { ctx.moveTo(0, e * H); ctx.lineTo(W, e * H); }
      else { ctx.moveTo(e * W, 0); ctx.lineTo(e * W, H); }
      ctx.stroke();
      ctx.restore();
    }

    // 3 ─ captured mass
    ctx.save();
    for (i = 0; i < grid.length; i++) {
      if (grid[i] !== 1) continue;
      c = i % COLS; r = (i - c) / COLS; x = c * CELL; y = r * CELL;
      var p = Math.min(1, Math.max(0, (now - claim[i]) / 260));
      if (p < 1) {
        var sc = 1 + (1 - p) * .5;
        ctx.globalAlpha = p;
        ctx.fillStyle = 'rgba(180,250,255,' + (.9 - p * .75) + ')';
        ctx.fillRect(x - (sc - 1) * CELL / 2, y - (sc - 1) * CELL / 2, CELL * sc, CELL * sc);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(30,110,130,0.30)';
      ctx.fillRect(x, y, CELL, CELL);
      ctx.fillStyle = 'rgba(46,230,246,0.10)';
      ctx.fillRect(x + 3, y + 3, CELL - 6, CELL - 6);
    }
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.6;
    ctx.shadowColor = ACCENT; ctx.shadowBlur = 9;
    ctx.beginPath();
    for (i = 0; i < grid.length; i++) {
      if (grid[i] !== 1) continue;
      c = i % COLS; r = (i - c) / COLS; x = c * CELL; y = r * CELL;
      if (r === 0 || grid[i - COLS] !== 1) { ctx.moveTo(x, y); ctx.lineTo(x + CELL, y); }
      if (r === ROWS - 1 || grid[i + COLS] !== 1) { ctx.moveTo(x, y + CELL); ctx.lineTo(x + CELL, y + CELL); }
      if (c === 0 || grid[i - 1] !== 1) { ctx.moveTo(x, y); ctx.lineTo(x, y + CELL); }
      if (c === COLS - 1 || grid[i + 1] !== 1) { ctx.moveTo(x + CELL, y); ctx.lineTo(x + CELL, y + CELL); }
    }
    ctx.stroke();
    ctx.restore();

    // 4 ─ growing wall + sparking heads
    if (wall) {
      ctx.save();
      ctx.shadowColor = ACCENT; ctx.shadowBlur = 22;
      ctx.fillStyle = 'rgba(46,230,246,0.30)';
      var ax = (wall.a.c + .5) * CELL, ay = (wall.a.r + .5) * CELL;
      var bx = (wall.b.c + .5) * CELL, by = (wall.b.r + .5) * CELL;
      if (wall.horiz) ctx.fillRect(ax - CELL / 2, ay - CELL / 2, bx - ax + CELL, CELL);
      else ctx.fillRect(ax - CELL / 2, ay - CELL / 2, CELL, by - ay + CELL);
      ctx.strokeStyle = '#dffdff'; ctx.lineWidth = Math.max(2, CELL * .21); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      var hs = [wall.a, wall.b];
      for (var hi = 0; hi < 2; hi++) {
        if (hs[hi].done) continue;
        var hx = (hs[hi].c + .5) * CELL, hy = (hs[hi].r + .5) * CELL;
        ctx.fillStyle = '#fff'; ctx.shadowBlur = 26;
        ctx.beginPath(); ctx.arc(hx, hy, CELL * .33, 0, 7); ctx.fill();
        if (Math.random() < .7) parts.push({
          x: hx, y: hy, vx: (Math.random() - .5) * 1.4, vy: (Math.random() - .5) * 1.4,
          l: 1, m: 12, c: ACCENT, s: CELL * .1
        });
      }
      ctx.restore();
    }

    // 5 ─ press preview: the exact span this tap will fill
    if (press) {
      c = Math.floor(press.x / CELL); r = Math.floor(press.y / CELL);
      if (c >= 0 && r >= 0 && c < COLS && r < ROWS && grid[r * COLS + c] === 0) {
        var a1 = horiz ? c : r, a2 = a1;
        while (a1 > 0 && grid[horiz ? r * COLS + (a1 - 1) : (a1 - 1) * COLS + c] === 0) a1--;
        var lim = horiz ? COLS - 1 : ROWS - 1;
        while (a2 < lim && grid[horiz ? r * COLS + (a2 + 1) : (a2 + 1) * COLS + c] === 0) a2++;
        ctx.save();
        ctx.globalAlpha = .5;
        ctx.strokeStyle = 'rgba(223,253,255,0.5)'; ctx.lineWidth = CELL - 4;
        ctx.shadowColor = ACCENT; ctx.shadowBlur = 16;
        ctx.beginPath();
        if (horiz) { ctx.moveTo(a1 * CELL, (r + .5) * CELL); ctx.lineTo((a2 + 1) * CELL, (r + .5) * CELL); }
        else { ctx.moveTo((c + .5) * CELL, a1 * CELL); ctx.lineTo((c + .5) * CELL, (a2 + 1) * CELL); }
        ctx.stroke();
        ctx.globalAlpha = 1; ctx.lineWidth = 2; ctx.strokeStyle = '#fff';
        ctx.beginPath(); ctx.arc((c + .5) * CELL, (r + .5) * CELL, CELL * .64, 0, 7); ctx.stroke();
        ctx.restore();
      }
    }

    // 6 ─ particles
    ctx.save();
    for (i = 0; i < parts.length; i++) {
      var pt = parts[i];
      ctx.globalAlpha = Math.max(0, pt.l) * .9;
      ctx.fillStyle = pt.c; ctx.shadowColor = pt.c; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.s, 0, 7); ctx.fill();
    }
    ctx.restore();

    // 7 ─ orbs + trails
    for (i = 0; i < balls.length; i++) {
      var b = balls[i];
      ctx.save();
      for (var ti = 0; ti < b.tr.length; ti += 2) {
        var kk = ti / b.tr.length;
        ctx.globalAlpha = kk * .28;
        ctx.fillStyle = ORB;
        ctx.beginPath(); ctx.arc(b.tr[ti], b.tr[ti + 1], R * (.3 + kk * .7), 0, 7); ctx.fill();
      }
      ctx.restore();
      ctx.save();
      ctx.shadowColor = ORB; ctx.shadowBlur = 20;
      var g = ctx.createRadialGradient(b.x - R * .3, b.y - R * .35, .5, b.x, b.y, R * 1.05);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(.35, ORB);
      g.addColorStop(1, 'rgba(120,10,60,0.9)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, 7); ctx.fill();
      ctx.restore();
    }

    // 8 ─ edges the wall will travel toward
    var pulse = .5 + .5 * Math.sin(now / 420);
    ctx.save();
    ctx.globalAlpha = .22 + pulse * .3;
    ctx.fillStyle = ACCENT; ctx.shadowColor = ACCENT; ctx.shadowBlur = 16;
    if (horiz) { ctx.fillRect(0, 0, 3, H); ctx.fillRect(W - 3, 0, 3, H); }
    else { ctx.fillRect(0, 0, W, 3); ctx.fillRect(0, H - 3, W, 3); }
    ctx.restore();

    if (flash > .02) {
      ctx.save();
      ctx.globalAlpha = flash * .35;
      ctx.fillStyle = flashColor;
      ctx.fillRect(-20, -20, W + 40, H + 40);
      ctx.restore();
    }
    ctx.restore();
  }

  // ── input ──────────────────────────────────────────────────
  function pointFrom(e) {
    var rect = el.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (W / rect.width),
      y: (e.clientY - rect.top) * (H / rect.height)
    };
  }

  el.canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    if (S.screen !== 'game' || wall) return;
    press = pointFrom(e);
  });
  el.canvas.addEventListener('pointermove', function (e) {
    if (!press) return;
    e.preventDefault();
    press = pointFrom(e);
  });
  el.canvas.addEventListener('pointercancel', function () { press = null; });
  el.canvas.addEventListener('pointerup', function (e) {
    if (!press) return;
    e.preventDefault();
    var p = press; press = null;
    if (S.screen !== 'game' || wall) return;

    var c = Math.floor(p.x / CELL), r = Math.floor(p.y / CELL);
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return;
    if (grid[r * COLS + c] !== 0) return;
    for (var i = 0; i < balls.length; i++) {
      if (Math.abs(balls[i].x - (c + .5) * CELL) < R + CELL &&
          Math.abs(balls[i].y - (r + .5) * CELL) < R + CELL) return;
    }

    var horiz = S.axis === 'h';
    grid[r * COLS + c] = 2;
    wall = {
      horiz: horiz,
      cells: [r * COLS + c],
      a: { c: c, r: r, dc: horiz ? -1 : 0, dr: horiz ? 0 : -1, done: false },
      b: { c: c, r: r, dc: horiz ? 1 : 0, dr: horiz ? 0 : 1, done: false }
    };
    burst((c + .5) * CELL, (r + .5) * CELL, 10, ACCENT, 1.6);
    if (navigator.vibrate) navigator.vibrate(8);
  });

  // axis toggle
  document.querySelectorAll('.seg-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var ax = btn.dataset.axis;
      if (S.axis === ax) return;
      S.axis = ax;
      axisFlash = performance.now();
      document.querySelectorAll('.seg-btn').forEach(function (b) {
        b.classList.toggle('is-on', b.dataset.axis === ax);
      });
      if (navigator.vibrate) navigator.vibrate(12);
    });
  });

  // keyboard convenience for desktop testing
  window.addEventListener('keydown', function (e) {
    if (e.key === 'h' || e.key === 'v') {
      var b = document.querySelector('.seg-btn[data-axis="' + e.key + '"]');
      if (b) b.click();
    }
    if (e.key === 'Escape' && S.screen === 'game') actions.pause();
    else if (e.key === 'Escape' && S.screen === 'paused') actions.resume();
  });

  var actions = {
    play: function () { startLevel(1, false); },
    levels: function () { stop(); show('levels'); },
    scores: function () { stop(); show('scores'); },
    title: function () { stop(); show('title'); },
    pause: function () { stop(); pauseAt = performance.now(); show('paused'); },
    resume: function () { t0 += performance.now() - pauseAt; last = performance.now(); show('game'); run(); },
    restart: function () { startLevel(S.level, false); },
    next: function () { startLevel(Math.min(MAX_LEVEL, S.level + 1), true); },
    quit: function () { stop(); show('title'); },
    'submit-score': function () { submitScore(); }
  };

  document.addEventListener('click', function (e) {
    var act = e.target.closest('[data-act]');
    if (act) {
      var fn = actions[act.dataset.act];
      if (fn) fn();
      return;
    }
    var tile = e.target.closest('.level-tile[data-level]');
    if (tile) startLevel(parseInt(tile.dataset.level, 10), false);
  });

  el.nicknameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitScore();
    }
  });

  window.addEventListener('resize', function () { if (!el.game.hidden) layout(); });

  // ── boot ───────────────────────────────────────────────────
  load();
  show('title');
})();
