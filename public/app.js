// NGワードゲーム クライアント
// SSE でサーバ状態を受信し、POST /api でアクションを送る。

const $ = (id) => document.getElementById(id);

// ---- 永続的な playerId ----
let playerId = localStorage.getItem("ng_pid");
if (!playerId) {
  playerId = "p" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem("ng_pid", playerId);
}
let myName = localStorage.getItem("ng_name") || "";

let roomCode = null;
let state = null;
let es = null;
let activeTarget = null;
let currentVoteId = null;
let localSettings = null;
let localInputWords = {}; // 入力フェーズのローカルバッファ { [targetId]: string[] }
let selectedPlayerId = null; // プレイ画面で選択中のプレイヤー

// ---- カウントアップタイマー ----
let gameStartTime = null;
let gameTimerHandle = null;

function startGameTimer() {
  if (gameStartTime) return; // 既に起動済み
  gameStartTime = Date.now();
  if (gameTimerHandle) clearInterval(gameTimerHandle);
  gameTimerHandle = setInterval(tickGameTimer, 1000);
}

function tickGameTimer() {
  if (!gameStartTime) return;
  const el = $("gameTimer");
  if (!el) return;
  const elapsed = Math.floor((Date.now() - gameStartTime) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const s = String(elapsed % 60).padStart(2, "0");
  el.textContent = `${m}:${s}`;
}

function stopGameTimer() {
  if (gameTimerHandle) clearInterval(gameTimerHandle);
  gameTimerHandle = null;
  gameStartTime = null;
}

// ---- API ----
async function api(type, extra = {}) {
  try {
    const res = await fetch("/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, playerId, roomCode, ...extra }),
    });
    return res.json();
  } catch (e) {
    const msg =
      location.protocol === "file:"
        ? "ファイルを直接開いています。サーバ起動後に http://localhost:3000 を開いてください。"
        : "サーバに接続できません。サーバ（node server.js）が起動しているか確認してください。";
    $("homeError").textContent = msg;
    showToast(msg);
    return { ok: false, error: msg };
  }
}

// ---- 接続: SSE（即時）+ ポーリング（保険） ----
let pollTimer = null;
let lastDisqualified = new Set();

function applyState(data) {
  if (!data || data.missing) return;
  if (!roomCode) return;
  const dq = new Set((data.players || []).filter((p) => p.disqualified).map((p) => p.id));
  for (const p of data.players || []) {
    if (dq.has(p.id) && !lastDisqualified.has(p.id)) {
      showToast(`${p.name} さんは失格になりました`);
      hideModal();
    }
  }
  lastDisqualified = dq;
  state = data;
  render();
  setConn(true);
}

function connect() {
  if (es) es.close();
  try {
    es = new EventSource(`/events?room=${roomCode}&pid=${playerId}`);
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "state") {
        applyState(data);
      } else if (data.type === "vote_result") {
        showToast(
          data.passed
            ? `${data.targetName} さんは失格になりました`
            : `投票は否決されました（${data.targetName}）`
        );
        hideModal();
      }
    };
    es.onerror = () => setConn(false);
  } catch {
    /* SSE 非対応でもポーリングで動く */
  }

  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, 1500);
}

async function poll() {
  if (!roomCode) return;
  try {
    const res = await fetch(`/state?room=${roomCode}&pid=${playerId}`, { cache: "no-store" });
    const data = await res.json();
    applyState(data);
  } catch {
    setConn(false);
  }
}

function setConn(ok) {
  const c = $("conn");
  if (!roomCode) { c.textContent = ""; return; }
  c.textContent = ok ? "● 接続中" : "● 再接続中…";
  c.className = "conn" + (ok ? "" : " off");
}

// ---- 画面切替 ----
function showScreen(id) {
  for (const s of document.querySelectorAll(".screen")) s.classList.add("hidden");
  $(id).classList.remove("hidden");
}

function render() {
  if (!state) return;
  // 退出ボタン表示
  $("leaveBtn").classList.toggle("hidden", !roomCode);
  switch (state.phase) {
    case "lobby":   renderLobby(); break;
    case "input":   renderInput(); break;
    case "reveal":
    case "playing": renderPlay(); break;
    case "ended":   renderEnd(); break;
  }
  renderVoteModal();
}

// ---- ロビー ----
function renderLobby() {
  showScreen("screen-lobby");
  stopGameTimer();
  $("lobbyCode").textContent = state.roomCode;
  const ul = $("lobbyPlayers");
  ul.innerHTML = "";
  for (const p of state.players) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}${p.id === state.you ? " <span class='badge'>あなた</span>" : ""}</span>`;
    if (p.isHost) li.innerHTML += `<span class="badge host">ホスト</span>`;
    if (!p.connected) li.innerHTML += `<span class="badge off">未接続</span>`;
    ul.appendChild(li);
  }
  $("hostSettings").classList.remove("hidden");
  if (state.isHost) {
    if (!localSettings) localSettings = { ...state.settings };
    renderSeg("segTime", localSettings.inputTimeLimitSec, true);
    renderSeg("segNg", localSettings.ngWordsPerPlayer, true);
    $("hostSettings").querySelector("h3").textContent = "ゲーム設定（ホスト）";
    updateConfirmBtn();
  } else {
    renderSeg("segTime", state.settings.inputTimeLimitSec, false);
    renderSeg("segNg", state.settings.ngWordsPerPlayer, false);
    $("hostSettings").querySelector("h3").textContent = "ゲーム設定（ホストが設定中）";
    $("confirmSettingsBtn").classList.add("hidden");
  }
  animateCount(state.players.length);
  $("startInputBtn").classList.toggle("hidden", !state.isHost);
  $("startInputBtn").disabled = state.players.length < 2;
  $("lobbyHint").textContent = state.isHost
    ? state.players.length < 2
      ? "2人以上集まると開始できます。"
      : "全員揃ったら「入力フェーズを開始」を押してください。"
    : "ホストの開始を待っています…";
}

function renderSeg(id, value, enabled) {
  for (const b of $(id).querySelectorAll("button")) {
    b.classList.toggle("active", parseInt(b.dataset.val, 10) === value);
    b.disabled = !enabled;
  }
}

function updateConfirmBtn() {
  const btn = $("confirmSettingsBtn");
  btn.classList.remove("hidden");
  const synced =
    state &&
    localSettings &&
    localSettings.inputTimeLimitSec === state.settings.inputTimeLimitSec &&
    localSettings.ngWordsPerPlayer === state.settings.ngWordsPerPlayer;
  if (synced) {
    btn.textContent = "✓ 設定 確定済み";
    btn.classList.add("confirmed");
  } else {
    btn.textContent = "設定を確定";
    btn.classList.remove("confirmed");
  }
}

// 参加人数アニメーション
let lastCount = 0;
function animateCount(n) {
  const el = $("pcNum");
  el.textContent = n;
  if (n > lastCount) {
    el.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.45)", offset: 0.4 }, { transform: "scale(1)" }],
      { duration: 450, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" }
    );
    burstParticles();
  }
  lastCount = n;
}

// ---- canvas パーティクル ----
let pcCanvas, pcCtx, pcParticles = [], pcRaf = null;
const PC_COLORS = ["#22c55e", "#4ade80", "#16a34a", "#86efac", "#bbf7d0"];

function ensurePcCanvas() {
  if (!pcCanvas) pcCanvas = $("pcCanvas");
  if (!pcCanvas) return false;
  const rect = pcCanvas.getBoundingClientRect();
  if (rect.width === 0) return false;
  const dpr = window.devicePixelRatio || 1;
  if (pcCanvas.width !== Math.round(rect.width * dpr) || pcCanvas.height !== Math.round(rect.height * dpr)) {
    pcCanvas.width = Math.round(rect.width * dpr);
    pcCanvas.height = Math.round(rect.height * dpr);
  }
  pcCtx = pcCanvas.getContext("2d");
  pcCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}

function burstParticles() {
  if (!ensurePcCanvas()) return;
  const w = pcCanvas.clientWidth, h = pcCanvas.clientHeight;
  const cx = w / 2, cy = h * 0.42;
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 2 + Math.random() * 4.5;
    pcParticles.push({
      x: cx, y: cy,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5,
      life: 1, decay: 0.012 + Math.random() * 0.015,
      size: 2.5 + Math.random() * 3.5,
      color: PC_COLORS[i % PC_COLORS.length],
    });
  }
  if (!pcRaf) pcRaf = requestAnimationFrame(stepParticles);
}

function stepParticles() {
  if (!pcCtx) { pcRaf = null; return; }
  const w = pcCanvas.clientWidth, h = pcCanvas.clientHeight;
  pcCtx.clearRect(0, 0, w, h);
  for (const p of pcParticles) { p.vy += 0.13; p.x += p.vx; p.y += p.vy; p.life -= p.decay; }
  pcParticles = pcParticles.filter((p) => p.life > 0);
  for (const p of pcParticles) {
    pcCtx.globalAlpha = Math.max(0, p.life);
    pcCtx.fillStyle = p.color;
    pcCtx.beginPath();
    pcCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    pcCtx.fill();
  }
  pcCtx.globalAlpha = 1;
  if (pcParticles.length > 0) { pcRaf = requestAnimationFrame(stepParticles); }
  else { pcCtx.clearRect(0, 0, w, h); pcRaf = null; }
}

// ---- 入力フェーズ ----
function renderInput() {
  showScreen("screen-input");

  const timerVal = state.timer != null ? state.timer : null;
  const expired = state.timerExpired;

  if (expired) {
    $("timer").textContent = "0";
    $("timerbar").classList.add("urgent");
    $("timerExpiredMsg").classList.remove("hidden");
  } else {
    $("timer").textContent = timerVal != null ? timerVal : "--";
    $("timerbar").classList.toggle("urgent", timerVal != null && timerVal <= 10);
    $("timerExpiredMsg").classList.add("hidden");
  }

  const others = state.players.filter((p) => p.id !== state.you);
  if (!activeTarget || !others.find((p) => p.id === activeTarget)) {
    activeTarget = others[0] ? others[0].id : null;
  }

  // タブ（ローカルバッファのカウントを表示）
  const tabs = $("targetTabs");
  tabs.innerHTML = "";
  for (const p of others) {
    const count = (localInputWords[p.id] || []).length;
    const warn = count < 2;
    const div = document.createElement("div");
    div.className = "tab" + (p.id === activeTarget ? " active" : "") + (warn ? " warn" : "");
    div.innerHTML = `${escapeHtml(p.name)}<span class="count">${count}</span>`;
    div.onclick = () => { activeTarget = p.id; renderInput(); };
    tabs.appendChild(div);
  }

  // ワード一覧（ローカルバッファから描画）
  const list = $("wordList");
  list.innerHTML = "";
  const words = activeTarget ? localInputWords[activeTarget] || [] : [];
  for (const w of words) {
    const li = document.createElement("li");
    li.textContent = w;
    const b = document.createElement("button");
    b.textContent = "×";
    b.onclick = () => removeWordLocal(activeTarget, w);
    li.appendChild(b);
    list.appendChild(li);
  }

  const done = state.iAmDone;
  $("doneInputBtn").disabled = done;
  $("doneInputBtn").textContent = done ? "入力完了済み" : "入力完了";
  $("wordInput").disabled = done;
  $("addWordBtn").disabled = done;

  const doneCount = state.players.filter((p) => p.inputDone).length;
  $("doneHint").textContent = `完了: ${doneCount} / ${state.players.length}人`;
}

function addWord() {
  if (state?.iAmDone) return;
  const inp = $("wordInput");
  const word = inp.value.trim();
  const errEl = $("wordError");

  if (word.length < 3) {
    errEl.textContent = "3文字以上入力してください";
    return;
  }
  if (!activeTarget) return;

  errEl.textContent = "";
  if (!localInputWords[activeTarget]) localInputWords[activeTarget] = [];
  if (!localInputWords[activeTarget].includes(word)) {
    localInputWords[activeTarget].push(word);
  }
  inp.value = "";
  inp.focus();
  renderInput();
}

function removeWordLocal(targetId, word) {
  if (!localInputWords[targetId]) return;
  localInputWords[targetId] = localInputWords[targetId].filter((w) => w !== word);
  renderInput();
}

// ---- NG公開 / プレイ中 ----
function renderPlay() {
  showScreen("screen-play");

  const playing = state.phase === "playing";
  $("playTitle").textContent = playing ? "ゲーム中" : "NGワード公開";
  $("playLead").textContent = playing
    ? "NGワードを言った人がいたら、その人のアイコンをタップして失格投票！"
    : "他のプレイヤーのNGワードです（自分のは見えません）。ホストの開始を待ちましょう。";

  // カウントアップタイマー
  const timerWrap = $("gameTimerWrap");
  if (playing) {
    timerWrap.classList.remove("hidden");
    startGameTimer();
  } else {
    timerWrap.classList.add("hidden");
    stopGameTimer();
  }

  // 選択中のプレイヤーが失格や退出してたら選択解除
  if (selectedPlayerId) {
    const p = state.players.find((p) => p.id === selectedPlayerId);
    if (!p || p.disqualified) {
      selectedPlayerId = null;
      $("voteBar").classList.add("hidden");
    }
  }

  // グリッドアイコン描画
  const grid = $("playerGrid");
  grid.innerHTML = "";
  for (const p of state.players) {
    const isMe = p.id === state.you;
    const card = document.createElement("div");
    card.className = "player-card" +
      (isMe ? " me" : "") +
      (p.disqualified ? " dq" : "") +
      (playing && !isMe && !p.disqualified ? " tappable" : "") +
      (p.id === selectedPlayerId ? " selected" : "");

    // アイコン（名前の頭文字）
    const iconEl = document.createElement("div");
    iconEl.className = "player-card-icon";
    iconEl.textContent = [...p.name][0] || "?";
    card.appendChild(iconEl);

    // 名前
    const nameEl = document.createElement("div");
    nameEl.className = "player-card-name";
    nameEl.textContent = p.name;
    if (isMe) {
      const youTag = document.createElement("span");
      youTag.className = "you-tag";
      youTag.textContent = "あなた";
      nameEl.appendChild(youTag);
    }
    card.appendChild(nameEl);

    // NGワード
    const ngEl = document.createElement("div");
    ngEl.className = "player-card-ng";
    if (p.disqualified) {
      const badge = document.createElement("span");
      badge.className = "dq-badge";
      badge.textContent = "失格";
      ngEl.appendChild(badge);
    } else if (isMe) {
      const secret = document.createElement("span");
      secret.className = "secret";
      secret.textContent = "秘密";
      ngEl.appendChild(secret);
    } else {
      const words = state.ngWords[p.id] || [];
      if (words.length === 0) {
        const empty = document.createElement("span");
        empty.className = "secret";
        empty.textContent = "なし";
        ngEl.appendChild(empty);
      } else {
        for (const w of words) {
          const s = document.createElement("span");
          s.textContent = w;
          ngEl.appendChild(s);
        }
      }
    }
    card.appendChild(ngEl);

    // タップで失格提案（playing中のみ）
    if (playing && !isMe && !p.disqualified) {
      card.onclick = () => selectPlayer(p);
    }

    grid.appendChild(card);
  }

  $("startGameBtn").classList.toggle("hidden", !(state.isHost && state.phase === "reveal"));
}

function selectPlayer(p) {
  if (state.vote) { showToast("既に投票中です"); return; }
  selectedPlayerId = p.id;
  $("voteBarName").textContent = p.name;
  $("voteBar").classList.remove("hidden");
  renderPlay();
}

function proposeDisqualify() {
  if (!selectedPlayerId) return;
  const p = state.players.find((pl) => pl.id === selectedPlayerId);
  if (!p) return;
  api("propose_disqualify", { targetId: selectedPlayerId }).then((r) => {
    if (!r.ok) showToast(r.error);
  });
  $("voteBar").classList.add("hidden");
  selectedPlayerId = null;
}

// ---- 投票モーダル ----
function renderVoteModal() {
  const v = state.vote;
  if (!v || !v.isVoter || v.hasVoted) {
    if (!v) { hideModal(); currentVoteId = null; }
    else if (v.isVoter && v.hasVoted) { hideModal(); }
    return;
  }
  currentVoteId = v.id;
  $("modalText").textContent = `${v.proposerName} さんの提案：\n${v.targetName} さんを失格にしますか？`;
  $("modalTally").textContent = `投票状況 ${v.tally}`;
  $("modal").classList.remove("hidden");
}

function vote(yes) {
  if (!currentVoteId) return;
  api("vote_disqualify", { voteId: currentVoteId, yes });
  hideModal();
}

function hideModal() {
  $("modal").classList.add("hidden");
}

// ---- 終了 ----
function renderEnd() {
  showScreen("screen-end");
  stopGameTimer();
  $("voteBar").classList.add("hidden");
  const alive = state.players.filter((p) => !p.disqualified);
  $("endResult").textContent =
    alive.length === 1 ? `優勝: ${alive[0].name} さん！` : "ゲームが終了しました。";
  $("restartBtn").classList.toggle("hidden", !state.isHost);
}

// ---- 共通 ----
let toastTimer = null;
function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function leave() {
  if (!confirm("ゲームから退出しますか？")) return;
  api("leave_room").finally(() => {
    if (es) es.close();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    localSettings = null;
    localInputWords = {};
    selectedPlayerId = null;
    lastCount = 0;
    roomCode = null;
    state = null;
    currentVoteId = null;
    stopGameTimer();
    hideModal();
    $("voteBar").classList.add("hidden");
    $("leaveBtn").classList.add("hidden");
    history.replaceState(null, "", location.pathname);
    resetHome();
    showScreen("screen-home");
    setConn(true);
  });
}

function resetHome() {
  $("joinBox").classList.add("hidden");
  $("joinCode").textContent = "";
  $("roomCodeInput").value = "";
  $("createBtn").classList.remove("hidden");
  $("joinBtn").textContent = "参加";
  $("homeError").textContent = "";
}

// ---- ホーム操作 ----
async function createRoom() {
  const name = $("nameInput").value.trim();
  if (!name) return ($("homeError").textContent = "名前を入力してください");
  saveName(name);
  const r = await api("create_room", { name });
  if (!r.ok) return ($("homeError").textContent = r.error);
  enterRoom(r.roomCode);
}

async function joinRoom(code) {
  const name = $("nameInput").value.trim();
  if (!name) return ($("homeError").textContent = "名前を入力してください");
  code = (code || $("roomCodeInput").value).trim().toUpperCase();
  if (!code) return ($("homeError").textContent = "部屋コードを入力してください");
  saveName(name);
  const r = await api("join_room", { name, roomCode: code });
  if (!r.ok) return ($("homeError").textContent = r.error);
  enterRoom(r.roomCode);
}

function enterRoom(code) {
  roomCode = code;
  localInputWords = {};
  selectedPlayerId = null;
  history.replaceState(null, "", `?room=${code}`);
  connect();
}

function saveName(n) {
  myName = n;
  localStorage.setItem("ng_name", n);
}

// ---- 初期化 ----
function init() {
  $("nameInput").value = myName;

  $("createBtn").onclick = createRoom;
  $("joinBtn").onclick = () => joinRoom();
  $("copyBtn").onclick = () => {
    const url = `${location.origin}/?room=${state.roomCode}`;
    navigator.clipboard?.writeText(url).then(
      () => showToast("招待URLをコピーしました"),
      () => prompt("このURLを共有してください", url)
    );
  };

  // セグメントボタン（ローカルバッファのみ更新）
  for (const b of $("segTime").querySelectorAll("button")) {
    b.onclick = () => {
      if (!localSettings) return;
      localSettings.inputTimeLimitSec = parseInt(b.dataset.val, 10);
      renderSeg("segTime", localSettings.inputTimeLimitSec, true);
      updateConfirmBtn();
    };
  }
  for (const b of $("segNg").querySelectorAll("button")) {
    b.onclick = () => {
      if (!localSettings) return;
      localSettings.ngWordsPerPlayer = parseInt(b.dataset.val, 10);
      renderSeg("segNg", localSettings.ngWordsPerPlayer, true);
      updateConfirmBtn();
    };
  }
  $("confirmSettingsBtn").onclick = async () => {
    if (!localSettings) return;
    const r = await api("update_settings", {
      inputTimeLimitSec: localSettings.inputTimeLimitSec,
      ngWordsPerPlayer: localSettings.ngWordsPerPlayer,
    });
    if (r.ok) showToast("設定を確定しました");
  };
  $("startInputBtn").onclick = async () => {
    if (localSettings) {
      await api("update_settings", {
        inputTimeLimitSec: localSettings.inputTimeLimitSec,
        ngWordsPerPlayer: localSettings.ngWordsPerPlayer,
      });
    }
    const r = await api("start_input");
    if (!r.ok) showToast(r.error);
  };

  // 入力フェーズ
  $("addWordBtn").onclick = addWord;
  $("wordInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addWord();
  });
  $("wordInput").addEventListener("input", () => {
    $("wordError").textContent = "";
  });
  $("doneInputBtn").onclick = async () => {
    // バリデーション: 全員に2つ以上
    if (!state) return;
    const others = state.players.filter((p) => p.id !== state.you);
    const incomplete = others.filter((p) => (localInputWords[p.id] || []).length < 2);
    if (incomplete.length > 0) {
      const names = incomplete.map((p) => p.name).join("、");
      showToast(`${names} さんへのワードが2つ未満です`);
      return;
    }
    const r = await api("finish_input", { words: localInputWords });
    if (!r.ok) showToast(r.error);
  };

  // プレイ画面
  $("startGameBtn").onclick = () => api("start_game").then((r) => !r.ok && showToast(r.error));
  $("voteBarYes").onclick = proposeDisqualify;
  $("voteBarClose").onclick = () => {
    selectedPlayerId = null;
    $("voteBar").classList.add("hidden");
    if (state?.phase === "playing") renderPlay();
  };

  // 投票モーダル
  $("voteYes").onclick = () => vote(true);
  $("voteNo").onclick = () => vote(false);

  // 終了画面
  $("restartBtn").onclick = () => {
    stopGameTimer();
    api("restart");
  };

  // 右上退出ボタン（全画面共通）
  $("leaveBtn").onclick = leave;

  // URL に部屋コードがあれば参加準備
  const params = new URLSearchParams(location.search);
  const code = params.get("room");
  if (code) {
    $("joinCode").textContent = code;
    $("joinBox").classList.remove("hidden");
    $("roomCodeInput").value = code;
    $("createBtn").classList.add("hidden");
    $("joinBtn").textContent = "この部屋に参加";
  }
}

document.addEventListener("DOMContentLoaded", init);
