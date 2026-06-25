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
let state = null; // 直近のサーバ状態
let es = null; // EventSource
let activeTarget = null; // 入力フェーズで選択中の対象
let currentVoteId = null; // モーダル表示中の投票
let localSettings = null; // ホストの設定バッファ（確定までサーバに送らない）

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
  if (!roomCode) return; // 退出後に遅れて届いた応答は無視（ホーム表示の上書き防止）
  // 失格者が増えたらトースト表示（vote_result の代わり）
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
  // SSE（使える環境なら即時反映）
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

  // ポーリング（SSE がバッファされる Cloudflare 無料トンネル等でも確実に動く保険）
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
  if (!roomCode) {
    c.textContent = "";
    return;
  }
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
  switch (state.phase) {
    case "lobby":
      renderLobby();
      break;
    case "input":
      renderInput();
      break;
    case "reveal":
    case "playing":
      renderPlay();
      break;
    case "ended":
      renderEnd();
      break;
  }
  renderVoteModal();
}

// ---- ロビー ----
function renderLobby() {
  showScreen("screen-lobby");
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
  // 設定（セグメントボタン）。ホストはデバイス側でバッファして即時描画。
  $("hostSettings").classList.remove("hidden");
  if (state.isHost) {
    if (!localSettings) localSettings = { ...state.settings };
    renderSeg("segTime", localSettings.inputTimeLimitSec, true);
    renderSeg("segNg", localSettings.ngWordsPerPlayer, true);
    $("hostSettings").querySelector("h3").textContent = "ゲーム設定（ホスト）";
    updateConfirmBtn();
  } else {
    // 非ホストはサーバの確定値を閲覧のみ
    renderSeg("segTime", state.settings.inputTimeLimitSec, false);
    renderSeg("segNg", state.settings.ngWordsPerPlayer, false);
    $("hostSettings").querySelector("h3").textContent = "ゲーム設定（ホストが設定中）";
    $("confirmSettingsBtn").classList.add("hidden");
  }

  // 参加人数アニメーション
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

// 確定ボタンの見た目（ローカル設定とサーバ確定値の差で「未確定/確定済み」を表示）
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

// 参加人数: 増えたら「数字はスケールのみ」+「canvasパーティクルで弾ける演出」
let lastCount = 0;
function animateCount(n) {
  const el = $("pcNum");
  el.textContent = n;
  if (n > lastCount) {
    // 数字はスケールのインのみ（再描画と無関係に動くWeb Animations API）
    el.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.45)", offset: 0.4 },
        { transform: "scale(1)" },
      ],
      { duration: 450, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" }
    );
    burstParticles();
  }
  lastCount = n;
}

// ---- canvas パーティクル（前レイヤー） ----
let pcCanvas, pcCtx, pcParticles = [], pcRaf = null;
const PC_COLORS = ["#22c55e", "#4ade80", "#16a34a", "#86efac", "#bbf7d0"];

function ensurePcCanvas() {
  if (!pcCanvas) pcCanvas = $("pcCanvas");
  if (!pcCanvas) return false;
  const rect = pcCanvas.getBoundingClientRect();
  if (rect.width === 0) return false; // 非表示中は描けない
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
  const w = pcCanvas.clientWidth;
  const h = pcCanvas.clientHeight;
  const cx = w / 2;
  const cy = h * 0.42;
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 2 + Math.random() * 4.5;
    pcParticles.push({
      x: cx,
      y: cy,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 1.5,
      life: 1,
      decay: 0.012 + Math.random() * 0.015,
      size: 2.5 + Math.random() * 3.5,
      color: PC_COLORS[i % PC_COLORS.length],
    });
  }
  if (!pcRaf) pcRaf = requestAnimationFrame(stepParticles);
}

function stepParticles() {
  if (!pcCtx) {
    pcRaf = null;
    return;
  }
  const w = pcCanvas.clientWidth;
  const h = pcCanvas.clientHeight;
  pcCtx.clearRect(0, 0, w, h);
  for (const p of pcParticles) {
    p.vy += 0.13; // 重力
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
  }
  pcParticles = pcParticles.filter((p) => p.life > 0);
  for (const p of pcParticles) {
    pcCtx.globalAlpha = Math.max(0, p.life);
    pcCtx.fillStyle = p.color;
    pcCtx.beginPath();
    pcCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    pcCtx.fill();
  }
  pcCtx.globalAlpha = 1;
  if (pcParticles.length > 0) {
    pcRaf = requestAnimationFrame(stepParticles);
  } else {
    pcCtx.clearRect(0, 0, w, h);
    pcRaf = null;
  }
}

// ---- 入力フェーズ ----
function renderInput() {
  showScreen("screen-input");
  $("timer").textContent = state.timer != null ? state.timer : "--";

  const others = state.players.filter((p) => p.id !== state.you);
  if (!activeTarget || !others.find((p) => p.id === activeTarget)) {
    activeTarget = others[0] ? others[0].id : null;
  }

  // タブ
  const tabs = $("targetTabs");
  tabs.innerHTML = "";
  for (const p of others) {
    const count = (state.myWords[p.id] || []).length;
    const div = document.createElement("div");
    div.className = "tab" + (p.id === activeTarget ? " active" : "");
    div.innerHTML = `${escapeHtml(p.name)}<span class="count">${count}</span>`;
    div.onclick = () => {
      activeTarget = p.id;
      renderInput();
    };
    tabs.appendChild(div);
  }

  // ワード一覧
  const list = $("wordList");
  list.innerHTML = "";
  const words = activeTarget ? state.myWords[activeTarget] || [] : [];
  for (const w of words) {
    const li = document.createElement("li");
    li.textContent = w;
    const b = document.createElement("button");
    b.textContent = "×";
    b.onclick = () => api("remove_word", { targetId: activeTarget, word: w });
    li.appendChild(b);
    list.appendChild(li);
  }

  const done = state.iAmDone;
  $("doneInputBtn").disabled = done;
  $("doneInputBtn").textContent = done ? "入力完了済み" : "入力完了";
  $("wordInput").disabled = done;
  $("addWordBtn").disabled = done;
  const doneCount = state.players.filter((p) => p.inputDone).length;
  $("doneHint").textContent = `完了: ${doneCount} / ${state.players.length}　（全員完了か時間切れで次へ）`;
}

function addWord() {
  const inp = $("wordInput");
  const word = inp.value.trim();
  if (!word || !activeTarget) return;
  api("submit_word", { targetId: activeTarget, word });
  inp.value = "";
  inp.focus();
}

// ---- NG公開 / プレイ中 ----
function renderPlay() {
  showScreen("screen-play");
  const playing = state.phase === "playing";
  $("playTitle").textContent = playing ? "ゲーム中" : "NGワード公開";
  $("playLead").textContent = playing
    ? "NGワードを言った人がいたら、その人をタップして失格投票！"
    : "他のプレイヤーのNGワードです（自分のは見えません）。ホストの開始を待ちましょう。";

  const ul = $("ngList");
  ul.innerHTML = "";
  for (const p of state.players) {
    const li = document.createElement("li");
    const isMe = p.id === state.you;
    if (isMe) li.classList.add("me");
    if (p.disqualified) li.classList.add("dq");

    let right = "";
    if (isMe) {
      right = `<span class="badge">あなたのNGは秘密</span>`;
    } else {
      const words = (state.ngWords[p.id] || []).map((w) => `<span>${escapeHtml(w)}</span>`).join("");
      right = `<div class="ng-words">${words || "<span class='badge'>なし</span>"}</div>`;
    }
    const dq = p.disqualified ? `<span class="badge dq">失格</span>` : "";
    li.innerHTML = `<span>${escapeHtml(p.name)}${isMe ? " (あなた)" : ""}${dq}</span>${right}`;

    // プレイ中のみ、生存している他人をタップで失格提案
    if (playing && !isMe && !p.disqualified) {
      li.classList.add("tappable");
      li.onclick = () => proposeDisqualify(p);
    }
    ul.appendChild(li);
  }

  $("startGameBtn").classList.toggle("hidden", !(state.isHost && state.phase === "reveal"));
}

function proposeDisqualify(p) {
  if (state.vote) {
    showToast("既に投票中です");
    return;
  }
  if (confirm(`${p.name} さんを失格にしますか？`)) {
    api("propose_disqualify", { targetId: p.id }).then((r) => {
      if (!r.ok) showToast(r.error);
    });
  }
}

// ---- 投票モーダル ----
function renderVoteModal() {
  const v = state.vote;
  if (!v || !v.isVoter || v.hasVoted) {
    // 自分が投票不要 or 投票済みなら閉じる（ただし結果待ち表示は残さない）
    if (!v) {
      hideModal();
      currentVoteId = null;
    } else if (v.isVoter && v.hasVoted) {
      // 投票済み: tally を見せたいのでモーダルは閉じてトーストでも良いが、ここは閉じる
      hideModal();
    }
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
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function leave() {
  if (!confirm("ゲームから退出しますか？")) return;
  api("leave_room").finally(() => {
    if (es) es.close();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    localSettings = null;
    lastCount = 0;
    roomCode = null;
    state = null;
    currentVoteId = null;
    hideModal();
    history.replaceState(null, "", location.pathname);
    resetHome();
    showScreen("screen-home");
    setConn(true);
  });
}

// ホーム画面を初期状態に戻す（URL参加→退出後の表示崩れ対策）
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
  // 設定はデバイス側のバッファを即時更新（サーバ送信しない）
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
  // 「設定を確定」でまとめてサーバ送信
  $("confirmSettingsBtn").onclick = async () => {
    if (!localSettings) return;
    const r = await api("update_settings", {
      inputTimeLimitSec: localSettings.inputTimeLimitSec,
      ngWordsPerPlayer: localSettings.ngWordsPerPlayer,
    });
    if (r.ok) showToast("設定を確定しました");
  };
  $("startInputBtn").onclick = async () => {
    // 念のため最新のローカル設定を確定してから開始
    if (localSettings) {
      await api("update_settings", {
        inputTimeLimitSec: localSettings.inputTimeLimitSec,
        ngWordsPerPlayer: localSettings.ngWordsPerPlayer,
      });
    }
    const r = await api("start_input");
    if (!r.ok) showToast(r.error);
  };
  $("addWordBtn").onclick = addWord;
  $("wordInput").addEventListener("keydown", (e) => e.key === "Enter" && addWord());
  $("doneInputBtn").onclick = () => api("finish_input");
  $("startGameBtn").onclick = () => api("start_game").then((r) => !r.ok && showToast(r.error));
  $("voteYes").onclick = () => vote(true);
  $("voteNo").onclick = () => vote(false);
  $("restartBtn").onclick = () => api("restart");

  for (const id of ["leaveLobbyBtn", "leaveInputBtn", "leavePlayBtn", "leaveEndBtn"]) {
    $(id).onclick = leave;
  }

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
