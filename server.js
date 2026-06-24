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

// ---- ゲーム状態（メモリ内） ----
/** @type {Map<string, Room>} */
const rooms = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function genRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(code));
  return code;
}

function now() {
  return Date.now();
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
      finishInputPhase(room);
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
    room.ngWords[target.id] = candidates.slice(0, room.settings.ngWordsPerPlayer);
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
    };
    room.players.set(msg.playerId, {
      id: msg.playerId,
      name,
      connected: false,
      disqualified: false,
      left: false,
      res: null,
    });
    rooms.set(code, room);
    return reply({ ok: true, roomCode: code });
  }

  if (type === "join_room") {
    const room = rooms.get(msg.roomCode);
    if (!room) return fail("部屋が見つかりません");
    const name = (msg.name || "").trim();
    if (!name) return fail("名前を入力してください");
    const existing = room.players.get(msg.playerId);
    if (existing) {
      // 再参加（リロード等）
      existing.name = name;
      existing.left = false;
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
    });
    broadcastState(room);
    return reply({ ok: true, roomCode: room.code });
  }

  // 以降は部屋とプレイヤーが必要
  const room = rooms.get(msg.roomCode);
  if (!room) return fail("部屋が見つかりません");
  const player = room.players.get(msg.playerId);
  if (!player) return fail("プレイヤー情報がありません。再参加してください");

  const isHost = msg.playerId === room.hostId;

  switch (type) {
    case "update_settings": {
      if (!isHost) return fail("ホストのみ設定できます");
      if (room.phase !== "lobby") return fail("ロビーでのみ設定できます");
      const t = parseInt(msg.inputTimeLimitSec, 10);
      const n = parseInt(msg.ngWordsPerPlayer, 10);
      if (Number.isFinite(t)) room.settings.inputTimeLimitSec = Math.min(600, Math.max(10, t));
      if (Number.isFinite(n)) room.settings.ngWordsPerPlayer = Math.min(10, Math.max(1, n));
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
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
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

  if (req.method === "POST" && url.pathname === "/api") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
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

server.listen(PORT, () => {
  console.log(`NGワードゲーム: http://localhost:${PORT}`);
});
