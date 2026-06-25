// NGワードゲーム サーバ
// 外部依存ゼロ（Node 標準ライブラリのみ）。
// - 静的ファイル配信（public/）
// - SSE（Server-Sent Events）でサーバ→クライアントのリアルタイム push
// - POST /api でクライアント→サーバのアクション
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;
const VOTE_TIMEOUT_MS = 30_000;
const PRESENCE_TIMEOUT_MS = 12_000; // この時間 通信が無く接続も無ければ退出扱い
const REAP_INTERVAL_MS = 5_000;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2時間 無操作の部屋は自動削除
const MAX_ROOMS = 2000; // メモリ枯渇防止の上限

// ---- ゲーム状態（メモリ内） ----
/** @type {Map<string, Room>} */
const rooms = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

// 紛らわしい文字（0/O/1/I/L）を除いた6桁。総当たり困難（約10億通り）。
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genRoomCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function now() {
  return Date.now();
}

// ---- レート制限（スライディングウィンドウ、IPごと） ----
const rateBuckets = new Map(); // key: "ip|name" -> { count, reset }
function rateLimit(ip, name, max, windowMs) {
  const key = ip + "|" + name;
  const t = now();
  let b = rateBuckets.get(key);
  if (!b || t > b.reset) {
    b = { count: 0, reset: t + windowMs };
    rateBuckets.set(key, b);
  }
  b.count++;
  return b.count <= max;
}
function getIp(req) {
  // Cloudflare 経由だと remoteAddress は 127.0.0.1 になるため実IPはヘッダから取る
  return (
    req.headers["cf-connecting-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// ---- ユーティリティ ----
function activePlayers(room) {
  return [...room.players.values()].filter((p) => !p.left);
}

function alivePlayers(room) {
  // ゲーム進行上「まだ生存」しているプレイヤー（退出/失格を除く）
  return activePlayers(room).filter((p) => !p.disqualified);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- SSE 送信 ----
function sendTo(player, data) {
  if (!player.res) return;
  try {
    player.res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* 切断済み */
  }
}

// 各プレイヤーごとに「自分のNGを除いた」個別状態を送る
function broadcastState(room) {
  for (const p of room.players.values()) {
    if (!p.res) continue;
    sendTo(p, buildStateFor(room, p));
  }
}

function buildStateFor(room, viewer) {
  const remaining =
    room.phase === "input" && room.inputTimerEnd
      ? Math.max(0, Math.ceil((room.inputTimerEnd - now()) / 1000))
      : null;

  const players = activePlayers(room).map((p) => ({
    id: p.id,
    name: p.name,
    connected: p.connected,
    disqualified: p.disqualified,
    isHost: p.id === room.hostId,
    inputDone: room.doneInput.has(p.id),
  }));

  const state = {
    type: "state",
    you: viewer.id,
    isHost: viewer.id === room.hostId,
    roomCode: room.code,
    phase: room.phase,
    settings: room.settings,
    players,
    timer: remaining,
    timerExpired: room.timerExpired || false,
  };

  // 入力フェーズ: 自分が各対象に入力済みのワード
  if (room.phase === "input") {
    state.myWords = {};
    for (const target of activePlayers(room)) {
      if (target.id === viewer.id) continue;
      state.myWords[target.id] = (room.submissions[target.id] || [])
        .filter((s) => s.fromId === viewer.id)
        .map((s) => s.word);
    }
    state.iAmDone = room.doneInput.has(viewer.id);
  }

  // reveal / playing: 自分以外のNGワードのみ
  if (room.phase === "reveal" || room.phase === "playing" || room.phase === "ended") {
    state.ngWords = {};
    for (const target of activePlayers(room)) {
      if (target.id === viewer.id) continue; // 自分のNGは秘匿
      state.ngWords[target.id] = room.ngWords[target.id] || [];
    }
  }

  // 進行中の投票（自分が投票者で、まだ対象が生存している場合）
  if (room.vote) {
    const v = room.vote;
    const target = room.players.get(v.targetId);
    const proposer = room.players.get(v.proposerId);
    const isVoter = v.voterIds.includes(viewer.id);
    state.vote = {
      id: v.id,
      targetId: v.targetId,
      targetName: target ? target.name : "?",
      proposerName: proposer ? proposer.name : "?",
      isVoter,
      hasVoted: v.votes.has(viewer.id),
      yourVote: v.votes.get(viewer.id) ?? null,
      tally: tallyText(room, v),
    };
  } else {
    state.vote = null;
  }

  return state;
}

function tallyText(room, v) {
  const needed = v.voterIds.filter((id) => {
    const p = room.players.get(id);
    return p && !p.left && !p.disqualified;
  });
  const voted = needed.filter((id) => v.votes.has(id)).length;
  return `${voted} / ${needed.length}`;
}

// ---- フェーズ遷移 ----
function startInputTimer(room) {
  clearInterval(room.tickHandle);
  room.tickHandle = setInterval(() => {
    if (room.phase !== "input") {
      clearInterval(room.tickHandle);
      return;
    }
    if (now() >= room.inputTimerEnd) {
      clearInterval(room.tickHandle);
      room.timerExpired = true; // タイマー切れ → 全員完了待ち
      broadcastState(room);
    } else {
      broadcastState(room);
    }
  }, 1000);
}

function finishInputPhase(room) {
  clearInterval(room.tickHandle);
  selectNgWords(room);
  room.phase = "reveal";
  broadcastState(room);
}

function selectNgWords(room) {
  room.ngWords = {};
  for (const target of activePlayers(room)) {
    const subs = room.submissions[target.id] || [];
    // 重複除去（trim + 小文字比較で集約、表示は元のまま）
    const seen = new Map();
    for (const s of subs) {
      const key = s.word.trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, s.word.trim());
    }
    const candidates = shuffle([...seen.values()]);
    const take = room.settings.ngWordsPerPlayer === 0 ? candidates.length : room.settings.ngWordsPerPlayer;
    room.ngWords[target.id] = candidates.slice(0, take);
  }
}

function checkAllInputDone(room) {
  const players = alivePlayers(room);
  if (players.length === 0) return;
  const allDone = players.every((p) => room.doneInput.has(p.id));
  if (allDone) finishInputPhase(room);
}

// ---- 投票ロジック ----
function resolveVote(room) {
  const v = room.vote;
  if (!v) return;
  const needed = v.voterIds.filter((id) => {
    const p = room.players.get(id);
    return p && !p.left && !p.disqualified;
  });
  // NO が1つでもあれば否決
  for (const id of needed) {
    if (v.votes.get(id) === false) {
      endVote(room, false);
      return;
    }
  }
  // 全員 YES で可決
  if (needed.length > 0 && needed.every((id) => v.votes.get(id) === true)) {
    endVote(room, true);
  }
}

function endVote(room, passed) {
  const v = room.vote;
  if (!v) return;
  clearTimeout(v.timer);
  const target = room.players.get(v.targetId);
  if (passed && target) target.disqualified = true;
  room.vote = null;

  for (const p of room.players.values()) {
    sendTo(p, {
      type: "vote_result",
      passed,
      targetName: target ? target.name : "?",
    });
  }
  broadcastState(room);

  // 残り1人なら終了
  if (passed && alivePlayers(room).length <= 1) {
    room.phase = "ended";
    broadcastState(room);
  }
}

// ---- アクション処理 ----
function handleAction(msg, res) {
  const reply = (obj) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  const fail = (error) => reply({ ok: false, error });

  const { type } = msg;

  if (type === "create_room") {
    const name = (msg.name || "").trim();
    if (!name) return fail("名前を入力してください");
    if (rooms.size >= MAX_ROOMS) return fail("混雑しています。しばらくしてからお試しください");
    const code = genRoomCode();
    const room = {
      code,
      hostId: msg.playerId,
      phase: "lobby",
      settings: { inputTimeLimitSec: 120, ngWordsPerPlayer: 2 },
      players: new Map(),
      submissions: {},
      ngWords: {},
      doneInput: new Set(),
      inputTimerEnd: null,
      tickHandle: null,
      vote: null,
      lastActivity: now(),
    };
    room.players.set(msg.playerId, {
      id: msg.playerId,
      name,
      connected: false,
      disqualified: false,
      left: false,
      res: null,
      lastSeen: now(),
    });
    rooms.set(code, room);
    return reply({ ok: true, roomCode: code });
  }

  if (type === "join_room") {
    // 入力コードは大文字に正規化（コードは英数字大文字のみ）
    const room = rooms.get(String(msg.roomCode || "").trim().toUpperCase());
    if (!room) return fail("部屋が見つかりません");
    room.lastActivity = now();
    const name = (msg.name || "").trim();
    if (!name) return fail("名前を入力してください");
    const existing = room.players.get(msg.playerId);
    if (existing) {
      // 再参加（リロード等）
      existing.name = name;
      existing.left = false;
      existing.lastSeen = now();
      broadcastState(room);
      return reply({ ok: true, roomCode: room.code });
    }
    if (room.phase !== "lobby") return fail("ゲームが既に開始しています");
    room.players.set(msg.playerId, {
      id: msg.playerId,
      name,
      connected: false,
      disqualified: false,
      left: false,
      res: null,
      lastSeen: now(),
    });
    broadcastState(room);
    return reply({ ok: true, roomCode: room.code });
  }

  // 以降は部屋とプレイヤーが必要
  const room = rooms.get(msg.roomCode);
  if (!room) return fail("部屋が見つかりません");
  const player = room.players.get(msg.playerId);
  if (!player) return fail("プレイヤー情報がありません。再参加してください");
  player.lastSeen = now();
  room.lastActivity = now();

  const isHost = msg.playerId === room.hostId;

  switch (type) {
    case "update_settings": {
      if (!isHost) return fail("ホストのみ設定できます");
      if (room.phase !== "lobby") return fail("ロビーでのみ設定できます");
      const t = parseInt(msg.inputTimeLimitSec, 10);
      const n = parseInt(msg.ngWordsPerPlayer, 10);
      if (Number.isFinite(t)) room.settings.inputTimeLimitSec = Math.min(600, Math.max(5, t));
      // ngWordsPerPlayer: 0 は「全て」を意味する
      if (Number.isFinite(n)) room.settings.ngWordsPerPlayer = n === 0 ? 0 : Math.min(10, Math.max(1, n));
      broadcastState(room);
      return reply({ ok: true });
    }

    case "start_input": {
      if (!isHost) return fail("ホストのみ開始できます");
      if (room.phase !== "lobby") return fail("既に開始しています");
      if (activePlayers(room).length < 2) return fail("2人以上必要です");
      room.phase = "input";
      room.submissions = {};
      room.doneInput = new Set();
      room.timerExpired = false;
      room.inputTimerEnd = now() + room.settings.inputTimeLimitSec * 1000;
      broadcastState(room);
      startInputTimer(room);
      return reply({ ok: true });
    }

    case "submit_word": {
      if (room.phase !== "input") return fail("入力フェーズではありません");
      const targetId = msg.targetId;
      const word = (msg.word || "").trim();
      if (!word) return fail("ワードが空です");
      if (targetId === player.id) return fail("自分には入力できません");
      if (!room.players.has(targetId)) return fail("対象が存在しません");
      room.submissions[targetId] = room.submissions[targetId] || [];
      // 同一人物が同じ対象に同じ語を重複登録しないように
      const dup = room.submissions[targetId].some(
        (s) => s.fromId === player.id && s.word.trim().toLowerCase() === word.toLowerCase()
      );
      if (!dup) room.submissions[targetId].push({ word, fromId: player.id });
      broadcastState(room);
      return reply({ ok: true });
    }

    case "remove_word": {
      if (room.phase !== "input") return fail("入力フェーズではありません");
      const targetId = msg.targetId;
      const word = (msg.word || "").trim();
      const list = room.submissions[targetId] || [];
      room.submissions[targetId] = list.filter(
        (s) => !(s.fromId === player.id && s.word.trim().toLowerCase() === word.toLowerCase())
      );
      broadcastState(room);
      return reply({ ok: true });
    }

    case "finish_input": {
      if (room.phase !== "input") return fail("入力フェーズではありません");
      // ローカルバッファのワードを一括登録
      const words = msg.words || {};
      for (const [targetId, wordList] of Object.entries(words)) {
        if (targetId === player.id) continue;
        if (!room.players.has(targetId)) continue;
        room.submissions[targetId] = room.submissions[targetId] || [];
        for (const w of wordList) {
          const word = String(w).trim().slice(0, 20);
          if (!word) continue;
          const dup = room.submissions[targetId].some(
            (s) => s.fromId === player.id && s.word.trim().toLowerCase() === word.toLowerCase()
          );
          if (!dup) room.submissions[targetId].push({ word, fromId: player.id });
        }
      }
      room.doneInput.add(player.id);
      broadcastState(room);
      checkAllInputDone(room);
      return reply({ ok: true });
    }

    case "start_game": {
      if (!isHost) return fail("ホストのみ開始できます");
      if (room.phase !== "reveal") return fail("公開フェーズではありません");
      room.phase = "playing";
      broadcastState(room);
      return reply({ ok: true });
    }

    case "propose_disqualify": {
      if (room.phase !== "playing") return fail("ゲーム中ではありません");
      if (room.vote) return fail("既に投票中です");
      const target = room.players.get(msg.targetId);
      if (!target || target.left || target.disqualified) return fail("対象が無効です");
      if (target.id === player.id) return fail("自分は提案できません");
      const voters = alivePlayers(room)
        .filter((p) => p.id !== target.id)
        .map((p) => p.id);
      const v = {
        id: "v" + now() + Math.floor(Math.random() * 1000),
        targetId: target.id,
        proposerId: player.id,
        voterIds: voters,
        votes: new Map(),
        timer: null,
      };
      v.votes.set(player.id, true); // 提案者は自動 YES
      room.vote = v;
      v.timer = setTimeout(() => {
        if (room.vote && room.vote.id === v.id) endVote(room, false);
      }, VOTE_TIMEOUT_MS);
      broadcastState(room);
      resolveVote(room); // 提案者が唯一の投票者の場合に即決
      return reply({ ok: true });
    }

    case "vote_disqualify": {
      const v = room.vote;
      if (!v || v.id !== msg.voteId) return fail("投票は終了しています");
      if (!v.voterIds.includes(player.id)) return fail("投票権がありません");
      v.votes.set(player.id, !!msg.yes);
      broadcastState(room);
      resolveVote(room);
      return reply({ ok: true });
    }

    case "leave_room": {
      removePlayer(room, player, /*permanent*/ true);
      return reply({ ok: true });
    }

    case "restart": {
      if (!isHost) return fail("ホストのみ操作できます");
      room.phase = "lobby";
      room.submissions = {};
      room.ngWords = {};
      room.doneInput = new Set();
      room.vote = null;
      room.inputTimerEnd = null;
      clearInterval(room.tickHandle);
      for (const p of room.players.values()) p.disqualified = false;
      broadcastState(room);
      return reply({ ok: true });
    }

    default:
      return fail("不明なアクション: " + type);
  }
}

function removePlayer(room, player, permanent) {
  player.left = true;
  player.connected = false;
  if (player.res) {
    try {
      player.res.end();
    } catch {}
    player.res = null;
  }
  // ホスト委譲
  if (player.id === room.hostId) {
    const next = activePlayers(room)[0];
    if (next) room.hostId = next.id;
  }
  // 進行中の投票への影響を再評価
  if (room.vote) {
    if (room.vote.targetId === player.id) {
      endVote(room, false); // 対象が退出 → 投票無効
    } else {
      resolveVote(room);
    }
  }
  // 入力フェーズで全員完了チェック
  if (room.phase === "input") checkAllInputDone(room);

  // 全員いなくなったら部屋削除
  if (activePlayers(room).length === 0) {
    clearInterval(room.tickHandle);
    rooms.delete(room.code);
    return;
  }
  broadcastState(room);
}

// ---- SSE 接続 ----
function handleSSE(req, res, url) {
  const roomCode = url.searchParams.get("room");
  const playerId = url.searchParams.get("pid");
  const room = rooms.get(roomCode);
  if (!room || !room.players.has(playerId)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");

  const player = room.players.get(playerId);
  player.res = res;
  player.connected = true;
  player.left = false;

  sendTo(player, buildStateFor(room, player));
  broadcastState(room);

  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {}
  }, 25_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    if (player.res === res) {
      player.res = null;
      player.connected = false;
      // SSE 切断は一時的（リロード等）かもしれないので left にはしない。
      broadcastState(room);
    }
  });
}

// ---- 静的ファイル ----
async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const ext = path.extname(filePath);
    // index.html は OGP の絶対URLを「現在アクセスされているURL」に動的置換
    // （公開URLが起動ごとに変わっても、サムネ画像が正しく参照される）
    if (ext === ".html") {
      let html = await readFile(filePath, "utf8");
      const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
      const base = `${proto}://${req.headers.host}`;
      html = html.replaceAll("__OG_BASE__", base);
      res.writeHead(200, { "Content-Type": MIME[ext] });
      res.end(html);
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

// ---- HTTP サーバ ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/events") {
    return handleSSE(req, res, url);
  }

  const ip = getIp(req);

  // ポーリング用: SSE が使えない環境（Cloudflare 無料トンネル等）向けの状態取得
  if (req.method === "GET" && url.pathname === "/state") {
    // ポーリングは高頻度なので上限は緩め（同一IPで複数人プレイも考慮）
    if (!rateLimit(ip, "state", 240, 10_000)) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ type: "state", missing: true }));
      return;
    }
    const room = rooms.get(url.searchParams.get("room"));
    const player = room && room.players.get(url.searchParams.get("pid"));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    if (!room || !player) {
      res.end(JSON.stringify({ type: "state", missing: true }));
      return;
    }
    player.connected = true;
    player.left = false;
    player.lastSeen = now();
    res.end(JSON.stringify(buildStateFor(room, player)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api") {
    // API全体のレート制限
    if (!rateLimit(ip, "api", 150, 10_000)) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "リクエストが多すぎます。少し待ってください" }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e5) req.destroy(); // 100KB上限
    });
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "不正なリクエスト" }));
        return;
      }
      // 部屋作成は厳しめに制限（スパムでメモリを食う攻撃を防ぐ）
      if (msg.type === "create_room" && !rateLimit(ip, "create", 5, 60_000)) {
        res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "部屋の作成が多すぎます。1分ほど待ってください" }));
        return;
      }
      try {
        handleAction(msg, res);
      } catch (e) {
        console.error(e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "サーバエラー" }));
      }
    });
    return;
  }

  if (req.method === "GET") {
    return serveStatic(req, res, url);
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
});

// ---- プレゼンス（生存確認）: いなくなったプレイヤーを自動退出 ----
// 生存 = SSE接続が開いている OR 直近で通信があった（バックグラウンドのタブは
// SSEが開いたままなので誤検知しない。ブラウザを閉じると接続が切れ通信も止まる）。
setInterval(() => {
  const t = now();
  for (const room of [...rooms.values()]) {
    const dropped = [];
    for (const p of room.players.values()) {
      if (p.left) continue;
      const present = p.res !== null || t - (p.lastSeen || 0) < PRESENCE_TIMEOUT_MS;
      if (!present) dropped.push(p);
    }
    for (const p of dropped) removePlayer(room, p, true);

    // 部屋の自動削除: 空 or 長時間 無操作なら破棄してメモリを解放
    if (rooms.has(room.code)) {
      const empty = activePlayers(room).length === 0;
      const stale = t - (room.lastActivity || 0) > ROOM_TTL_MS;
      if (empty || stale) {
        clearInterval(room.tickHandle);
        for (const p of room.players.values()) {
          if (p.res) {
            try {
              p.res.end();
            } catch {}
          }
        }
        rooms.delete(room.code);
      }
    }
  }

  // 期限切れのレート制限バケットを掃除（メモリリーク防止）
  for (const [key, b] of rateBuckets) {
    if (t > b.reset) rateBuckets.delete(key);
  }
}, REAP_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`NGワードゲーム: http://localhost:${PORT}`);
});
