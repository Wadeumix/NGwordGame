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

// ---- API ----
async function api(type, extra = {}) {
  const res = await fetch("/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, playerId, roomCode, ...extra }),
  });
  return res.json();
}

// ---- SSE 接続 ----
function connect() {
  if (es) es.close();
  es = new EventSource(`/events?room=${roomCode}&pid=${playerId}`);
  es.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "state") {
      state = data;
      render();
      setConn(true);
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
  // 設定
  $("hostSettings").classList.toggle("hidden", !state.isHost);
  if (state.isHost) {
    if (document.activeElement !== $("setTime")) $("setTime").value = state.settings.inputTimeLimitSec;
    if (document.activeElement !== $("setNg")) $("setNg").value = state.settings.ngWordsPerPlayer;
  }
  $("startInputBtn").classList.toggle("hidden", !state.isHost);
  $("startInputBtn").disabled = state.players.length < 2;
  $("lobbyHint").textContent = state.isHost
    ? state.players.length < 2
      ? "2人以上集まると開始できます。"
      : "全員揃ったら「入力フェーズを開始」を押してください。"
    : "ホストの開始を待っています…";
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
    roomCode = null;
    state = null;
    history.replaceState(null, "", location.pathname);
    showScreen("screen-home");
    setConn(true);
  });
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
  code = (code || $("roomCodeInput").value).trim();
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
  $("setTime").onchange = () =>
    api("update_settings", { inputTimeLimitSec: $("setTime").value, ngWordsPerPlayer: $("setNg").value });
  $("setNg").onchange = () =>
    api("update_settings", { inputTimeLimitSec: $("setTime").value, ngWordsPerPlayer: $("setNg").value });
  $("startInputBtn").onclick = () => api("start_input").then((r) => !r.ok && showToast(r.error));
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
