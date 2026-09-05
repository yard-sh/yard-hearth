// Hearth frontend.
//
// All fetches are relative ("api/me", never "/api/me") so the app works under
// any mount path and inside a sandbox. The route lives in location.hash for
// the same reason: the document path never moves, so relative URLs stay valid.
(function () {
  "use strict";

  var GROUP_WINDOW = 5 * 60 * 1000; // messages this close from one author merge
  var TYPING_TTL = 4000;

  var state = {
    me: null,
    servers: [],
    serverId: null,
    server: null,
    channelId: null,
    live: null,
    messages: [],
    peers: new Map(), // cid -> peer, everyone currently connected here
    typing: new Map(), // cid -> {name, until}
    ready: false,
  };

  var $ = function (id) {
    return document.getElementById(id);
  };

  var els = {};
  [
    "app", "blank", "railList", "railAdd", "railHome", "serverBtn", "serverName",
    "channelPane", "channelAdd", "channelList", "meAvatar", "meName", "meSub",
    "profileBtn", "channelTitle", "roleChip", "membersBtn", "messages", "typing",
    "composer", "composerInput", "sendBtn", "membersPane", "membersList", "scrim",
    "createForm", "createName", "createErr", "joinForm", "joinCode", "joinErr",
    "channelForm", "channelName", "channelErr", "profileForm", "profileName",
    "profileErr", "inviteCode", "copyCode", "memberAdmin", "serverDanger", "toast",
  ].forEach(function (id) {
    els[id] = $(id);
  });

  /* ------------------------------------------------------------------ dom */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "class") node.className = attrs[key];
        else if (key === "text") node.textContent = attrs[key];
        else if (key === "html") node.innerHTML = attrs[key];
        else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), attrs[key]);
        else if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function icon(path, size) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (size) {
      svg.style.width = size + "px";
      svg.style.height = size + "px";
    }
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", path);
    svg.appendChild(p);
    return svg;
  }

  var TRASH = "M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z";

  /* ---------------------------------------------------------------- utils */

  // A person keeps the same avatar colour everywhere, derived from their id.
  function colorOf(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h % 8;
  }

  function initial(name) {
    return (name || "?").trim().charAt(0).toUpperCase() || "?";
  }

  function avatar(userId, name, extra) {
    return el("span", {
      class: "avatar c" + colorOf(userId) + (extra ? " " + extra : ""),
      text: initial(name),
      title: name,
    });
  }

  function clock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function dayLabel(ts) {
    var d = new Date(ts);
    var today = new Date();
    var yday = new Date(today.getTime() - 86400000);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
  }

  var toastTimer = null;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.hidden = true;
    }, 3000);
  }

  function isAdmin() {
    return state.server && state.server.role === "admin";
  }

  /* ------------------------------------------------------------------ api */

  async function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || "GET" };
    if (opts.body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(opts.body);
    }
    var res = await fetch(path, init);
    var body = {};
    try {
      body = await res.json();
    } catch (e) {
      // Empty or non-JSON body; the status still decides.
    }
    if (!res.ok) {
      var err = new Error(body.error || "something went wrong");
      err.status = res.status;
      err.code = body.code;
      throw err;
    }
    return body;
  }

  /* --------------------------------------------------------------- render */

  function renderRail() {
    els.railList.replaceChildren();
    state.servers.forEach(function (server) {
      var pill = el("button", {
        class: "pill" + (server.id === state.serverId ? " active" : ""),
        type: "button",
        title: server.name + "  ·  " + server.id,
        text: initial(server.name),
        onclick: function () {
          openServer(server.id);
        },
      });
      els.railList.appendChild(pill);
    });
  }

  function renderSidebar() {
    var server = state.server;
    els.serverName.textContent = server ? server.name : "Hearth";
    els.channelAdd.hidden = !isAdmin();

    els.channelList.replaceChildren();
    if (!server) return;

    server.channels.forEach(function (channel) {
      var row = el("li", {
        class: "channel-row" + (channel.id === state.channelId ? " active" : ""),
        onclick: function (e) {
          if (e.target.closest(".kill")) return;
          openChannel(channel.id);
        },
      }, [
        el("span", { class: "hash", text: "#" }),
        el("span", { class: "nm", text: channel.name }),
      ]);

      // Deleting a channel is admin-only here and again on the server; hiding
      // the button is a convenience, not the check.
      if (isAdmin()) {
        var kill = el("button", {
          class: "kill",
          type: "button",
          title: "Delete #" + channel.name,
          "aria-label": "Delete #" + channel.name,
          onclick: function (e) {
            e.stopPropagation();
            deleteChannel(channel);
          },
        }, [icon(TRASH)]);
        row.appendChild(kill);
      }
      els.channelList.appendChild(row);
    });
  }

  function renderMe() {
    if (!state.me) return;
    els.meName.textContent = state.me.username;
    els.meAvatar.textContent = initial(state.me.username);
    els.meAvatar.className = "avatar c" + colorOf(state.me.user_id);
    els.meSub.textContent = state.server ? state.server.role : "online";
  }

  function currentChannel() {
    if (!state.server) return null;
    return state.server.channels.find(function (c) {
      return c.id === state.channelId;
    }) || null;
  }

  function renderTopbar() {
    var channel = currentChannel();
    els.channelTitle.textContent = channel ? channel.name : "no channel";
    if (state.server) {
      els.roleChip.hidden = false;
      els.roleChip.textContent = state.server.role;
    } else {
      els.roleChip.hidden = true;
    }
    var live = !!channel;
    els.composerInput.disabled = !live;
    els.sendBtn.disabled = !live;
    els.composerInput.placeholder = channel ? "Message #" + channel.name : "Message";
  }

  function canDelete(message) {
    if (!state.me) return false;
    return isAdmin() || message.author_id === state.me.user_id;
  }

  function renderMessages() {
    var box = els.messages;
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren();

    var channel = currentChannel();
    if (channel) {
      box.appendChild(
        el("div", { class: "intro" }, [
          el("div", { class: "intro-mark", text: "#" }),
          el("h2", { text: "Welcome to #" + channel.name }),
          el("p", { text: "This is the start of the #" + channel.name + " channel." }),
        ]),
      );
    }

    var lastDay = null;
    var prev = null;
    state.messages.forEach(function (message) {
      var day = new Date(message.at).toDateString();
      if (day !== lastDay) {
        box.appendChild(el("div", { class: "day", text: dayLabel(message.at) }));
        lastDay = day;
        prev = null;
      }
      var grouped =
        prev &&
        prev.author_id === message.author_id &&
        message.at - prev.at < GROUP_WINDOW;
      box.appendChild(renderMessage(message, grouped));
      prev = message;
    });

    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function renderMessage(message, grouped) {
    var admin = isAdmin() && message.author_id !== state.me.user_id;
    var node = el("div", { class: "msg" + (grouped ? " grouped" : ""), "data-id": message.id }, [
      el("div", { class: "gutter" }, [
        grouped
          ? el("span", { class: "stamp", text: clock(message.at) })
          : avatar(message.author_id, message.author_name),
      ]),
      el("div", {}, [
        grouped
          ? null
          : el("div", { class: "msg-head" }, [
              el("span", { class: "author", text: message.author_name }),
              el("span", { class: "when", text: clock(message.at) }),
            ]),
        el("div", { class: "body", text: message.body }),
      ]),
    ]);

    if (canDelete(message)) {
      node.appendChild(
        el("button", {
          class: "del",
          type: "button",
          title: admin ? "Delete as admin" : "Delete message",
          "aria-label": "Delete message",
          onclick: function () {
            if (state.live) state.live.send({ t: "delete", id: message.id });
          },
        }, [icon(TRASH)]),
      );
    }
    return node;
  }

  function renderMembers() {
    els.membersList.replaceChildren();
    if (!state.server) return;

    var online = new Set();
    state.peers.forEach(function (peer) {
      online.add(peer.user_id);
    });
    if (state.me) online.add(state.me.user_id);

    var here = state.server.members.filter(function (m) {
      return online.has(m.user_id);
    });
    var away = state.server.members.filter(function (m) {
      return !online.has(m.user_id);
    });

    function group(label, list, isHere) {
      if (!list.length) return;
      els.membersList.appendChild(
        el("div", { class: "member-group", text: label + " — " + list.length }),
      );
      list.forEach(function (m) {
        els.membersList.appendChild(
          el("div", { class: "member" + (isHere ? " here" : "") }, [
            avatar(m.user_id, m.username),
            el("span", { class: "nm", text: m.username }),
            m.role === "admin" ? el("span", { class: "badge", text: "admin" }) : null,
            isHere ? el("span", { class: "dot" }) : null,
          ]),
        );
      });
    }

    group("In this channel", here, true);
    group("Offline", away, false);
  }

  function renderTyping() {
    var now = Date.now();
    var names = [];
    state.typing.forEach(function (entry, cid) {
      if (entry.until < now) state.typing.delete(cid);
      else names.push(entry.name);
    });
    if (!names.length) {
      els.typing.textContent = "";
      return;
    }
    els.typing.textContent =
      names.length === 1
        ? names[0] + " is typing…"
        : names.slice(0, 3).join(", ") + " are typing…";
  }

  setInterval(renderTyping, 1000);

  function renderAll() {
    renderRail();
    renderSidebar();
    renderMe();
    renderTopbar();
    renderMessages();
    renderMembers();
  }

  /* ------------------------------------------------------------- realtime */

  function disconnect() {
    if (state.live) {
      state.live.close();
      state.live = null;
    }
    state.peers.clear();
    state.typing.clear();
    state.messages = [];
  }

  function connect(channelId) {
    disconnect();
    state.live = window.HearthLive.connect(channelId, {
      event: onEvent,
      status: function (value) {
        if (value === "closed") els.meSub.textContent = "reconnecting…";
        else renderMe();
      },
    });
  }

  function onEvent(event) {
    switch (event.t) {
      case "snapshot":
        state.messages = event.messages || [];
        state.peers.clear();
        (event.peers || []).forEach(function (peer) {
          state.peers.set(peer.cid, peer);
        });
        state.peers.set(event.you.cid, event.you);
        // The object is the authority on the role attached to this
        // connection; keep the UI in step with it.
        if (state.server && event.you.role !== state.server.role) {
          state.server.role = event.you.role;
          renderSidebar();
          renderTopbar();
        }
        renderMessages();
        renderMembers();
        renderMe();
        break;

      case "message":
        state.messages.push(event.message);
        renderMessages();
        break;

      case "delete":
        state.messages = state.messages.filter(function (m) {
          return m.id !== event.id;
        });
        renderMessages();
        break;

      case "join":
        state.peers.set(event.peer.cid, event.peer);
        renderMembers();
        break;

      case "leave":
        state.peers.delete(event.cid);
        state.typing.delete(event.cid);
        renderMembers();
        break;

      case "typing":
        state.typing.set(event.cid, { name: event.name, until: Date.now() + TYPING_TTL });
        renderTyping();
        break;

      case "rename":
        state.messages.forEach(function (m) {
          if (m.author_id === event.user_id) m.author_name = event.name;
        });
        state.peers.forEach(function (peer) {
          if (peer.user_id === event.user_id) peer.name = event.name;
        });
        if (state.server) {
          state.server.members.forEach(function (m) {
            if (m.user_id === event.user_id) m.username = event.name;
          });
        }
        renderMessages();
        renderMembers();
        break;

      case "role":
        if (state.server) {
          state.server.members.forEach(function (m) {
            if (m.user_id === event.user_id) m.role = event.role;
          });
          if (state.me && event.user_id === state.me.user_id) {
            state.server.role = event.role;
            toast("You are now " + (event.role === "admin" ? "an admin" : "a user") + " here.");
            renderSidebar();
            renderTopbar();
            renderMe();
          }
        }
        renderMessages();
        renderMembers();
        break;

      case "channel":
        var channel = currentChannel();
        if (channel) {
          channel.name = event.name;
          renderSidebar();
          renderTopbar();
        }
        break;

      case "gone":
        toast("This channel was deleted.");
        disconnect();
        refreshServer(state.serverId);
        break;

      case "error":
        toast(event.message || "that did not work");
        break;
    }
  }

  /* ------------------------------------------------------------ navigation */

  function writeHash() {
    var next = state.serverId ? "#" + state.serverId + (state.channelId ? "/" + state.channelId : "") : "";
    if (location.hash !== next) {
      suppressHash = true;
      location.hash = next;
    }
  }

  var suppressHash = false;

  async function openServer(serverId, channelId) {
    if (!serverId) return;
    try {
      var detail = await api("api/servers/" + serverId);
      state.serverId = serverId;
      state.server = detail;
      var target =
        (channelId && detail.channels.some(function (c) { return c.id === channelId; }) && channelId) ||
        (detail.channels[0] && detail.channels[0].id) ||
        null;
      state.channelId = target;
      writeHash();
      renderAll();
      if (target) connect(target);
      else disconnect();
    } catch (err) {
      toast(err.message);
      state.serverId = null;
      state.server = null;
      state.channelId = null;
      writeHash();
      renderAll();
    }
  }

  function openChannel(channelId) {
    if (channelId === state.channelId) return;
    state.channelId = channelId;
    writeHash();
    renderSidebar();
    renderTopbar();
    renderMessages();
    connect(channelId);
  }

  async function refreshServer(serverId) {
    if (!serverId) return;
    try {
      state.server = await api("api/servers/" + serverId);
    } catch (err) {
      // Membership may be gone (left or deleted); fall back to the list.
      await refreshServers();
      return;
    }
    var stillThere = state.server.channels.some(function (c) {
      return c.id === state.channelId;
    });
    if (!stillThere) {
      state.channelId = state.server.channels[0] ? state.server.channels[0].id : null;
      writeHash();
      if (state.channelId) connect(state.channelId);
      else disconnect();
    }
    renderAll();
  }

  async function refreshServers() {
    state.servers = await api("api/servers");
    if (!state.servers.length) {
      disconnect();
      state.serverId = null;
      state.server = null;
      state.channelId = null;
      showBlank(true);
      writeHash();
      return;
    }
    showBlank(false);
    var stillIn = state.servers.some(function (s) {
      return s.id === state.serverId;
    });
    if (!stillIn) await openServer(state.servers[0].id);
    else renderRail();
  }

  function showBlank(blank) {
    els.blank.hidden = !blank;
    els.app.hidden = blank;
  }

  /* --------------------------------------------------------------- modals */

  var openModal = null;

  function show(name) {
    hide();
    var node = $("modal-" + name);
    if (!node) return;
    openModal = node;
    node.hidden = false;
    els.scrim.hidden = false;
    var field = node.querySelector("input");
    if (field) setTimeout(function () { field.focus(); field.select(); }, 0);
  }

  function hide() {
    if (openModal) openModal.hidden = true;
    openModal = null;
    els.scrim.hidden = true;
    ["createErr", "joinErr", "channelErr", "profileErr"].forEach(function (id) {
      els[id].hidden = true;
    });
  }

  function fail(errEl, message) {
    errEl.textContent = message;
    errEl.hidden = false;
  }

  els.scrim.addEventListener("click", hide);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hide();
  });
  document.addEventListener("click", function (e) {
    var closer = e.target.closest("[data-close]");
    if (closer) hide();
    var opener = e.target.closest("[data-open]");
    if (opener) show(opener.getAttribute("data-open"));
  });

  /* --------------------------------------------------------------- actions */

  els.railAdd.addEventListener("click", function () {
    show("create");
  });

  els.railHome.addEventListener("click", function () {
    show("join");
  });

  els.createForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    try {
      var created = await api("api/servers", { method: "POST", body: { name: els.createName.value } });
      els.createName.value = "";
      hide();
      await refreshServers();
      await openServer(created.id);
      toast("Server created. Your ID is " + created.id + " — share it to invite people.");
    } catch (err) {
      fail(els.createErr, err.message);
    }
  });

  els.joinForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    try {
      var joined = await api("api/servers/join", { method: "POST", body: { code: els.joinCode.value } });
      els.joinCode.value = "";
      hide();
      await refreshServers();
      await openServer(joined.id);
      toast(joined.already_member ? "You are already in " + joined.name + "." : "Joined " + joined.name + ".");
    } catch (err) {
      fail(els.joinErr, err.message);
    }
  });

  els.channelAdd.addEventListener("click", function () {
    show("channel");
  });

  els.channelForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    try {
      var channel = await api("api/servers/" + state.serverId + "/channels", {
        method: "POST",
        body: { name: els.channelName.value },
      });
      els.channelName.value = "";
      hide();
      await refreshServer(state.serverId);
      openChannel(channel.id);
    } catch (err) {
      fail(els.channelErr, err.message);
    }
  });

  async function deleteChannel(channel) {
    if (!window.confirm("Delete #" + channel.name + "? Its messages go with it.")) return;
    try {
      await api("api/servers/" + state.serverId + "/channels/" + channel.id, { method: "DELETE" });
      if (channel.id === state.channelId) disconnect();
      await refreshServer(state.serverId);
      toast("#" + channel.name + " deleted.");
    } catch (err) {
      toast(err.message);
    }
  }

  els.profileBtn.addEventListener("click", function () {
    els.profileName.value = state.me ? state.me.username : "";
    show("profile");
  });

  els.profileForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    try {
      state.me = await api("api/me", { method: "PATCH", body: { username: els.profileName.value } });
      hide();
      renderMe();
      if (state.serverId) await refreshServer(state.serverId);
      toast("Username updated.");
    } catch (err) {
      fail(els.profileErr, err.message);
    }
  });

  els.membersBtn.addEventListener("click", function () {
    els.membersPane.hidden = !els.membersPane.hidden;
  });

  /* ----------------------------------------------------- server settings */

  els.serverBtn.addEventListener("click", function () {
    if (!state.server) return;
    renderServerModal();
    show("server");
  });

  function renderServerModal() {
    var server = state.server;
    els.inviteCode.textContent = server.id;
    els.memberAdmin.replaceChildren();

    server.members.forEach(function (m) {
      var row = el("div", { class: "admin-row" }, [
        avatar(m.user_id, m.username),
        el("span", { class: "nm", text: m.username }),
        m.is_owner
          ? el("span", { class: "tag", text: "owner" })
          : el("span", { class: "tag", text: m.role }),
      ]);

      // Promotion is admin-only, and the owner's role is fixed so a server can
      // never end up with nobody who can run it.
      if (isAdmin() && !m.is_owner) {
        row.appendChild(
          el("button", {
            class: "btn ghost small act",
            type: "button",
            text: m.role === "admin" ? "Make user" : "Make admin",
            onclick: function () {
              setRole(m, m.role === "admin" ? "user" : "admin");
            },
          }),
        );
      }
      els.memberAdmin.appendChild(row);
    });

    els.serverDanger.textContent = server.is_owner ? "Delete server" : "Leave server";
  }

  async function setRole(member, role) {
    try {
      await api("api/servers/" + state.serverId + "/members/" + member.user_id + "/role", {
        method: "POST",
        body: { role: role },
      });
      await refreshServer(state.serverId);
      renderServerModal();
      toast(member.username + " is now " + (role === "admin" ? "an admin" : "a user") + ".");
    } catch (err) {
      toast(err.message);
    }
  }

  els.copyCode.addEventListener("click", async function () {
    try {
      await navigator.clipboard.writeText(state.server.id);
      toast("Server ID copied.");
    } catch (err) {
      toast("Copy failed — the ID is " + state.server.id);
    }
  });

  els.serverDanger.addEventListener("click", async function () {
    var server = state.server;
    if (!server) return;
    var owner = server.is_owner;
    var question = owner
      ? "Delete " + server.name + "? Every channel and message goes with it."
      : "Leave " + server.name + "?";
    if (!window.confirm(question)) return;
    try {
      if (owner) await api("api/servers/" + server.id, { method: "DELETE" });
      else await api("api/servers/" + server.id + "/leave", { method: "POST" });
      hide();
      disconnect();
      state.serverId = null;
      state.server = null;
      state.channelId = null;
      await refreshServers();
      toast(owner ? "Server deleted." : "You left " + server.name + ".");
    } catch (err) {
      toast(err.message);
    }
  });

  /* -------------------------------------------------------------- composer */

  var lastTyping = 0;

  els.composerInput.addEventListener("input", function () {
    var now = Date.now();
    if (now - lastTyping < 2000 || !state.live) return;
    lastTyping = now;
    state.live.send({ t: "typing" });
  });

  els.composer.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = els.composerInput.value;
    if (!body.trim() || !state.live) return;
    if (state.live.send({ t: "send", body: body })) {
      els.composerInput.value = "";
    } else {
      toast("Still reconnecting — try that again in a moment.");
    }
  });

  /* ------------------------------------------------------------------ boot */

  window.addEventListener("hashchange", function () {
    if (suppressHash) {
      suppressHash = false;
      return;
    }
    var route = parseHash();
    if (route.serverId && route.serverId !== state.serverId) openServer(route.serverId, route.channelId);
    else if (route.channelId && route.channelId !== state.channelId) openChannel(route.channelId);
  });

  function parseHash() {
    var parts = location.hash.replace(/^#/, "").split("/");
    return { serverId: parts[0] || null, channelId: parts[1] || null };
  }

  async function boot() {
    try {
      state.me = await api("api/me");
    } catch (err) {
      document.body.textContent = "Could not load Hearth: " + err.message;
      return;
    }
    state.servers = await api("api/servers");
    renderMe();

    if (!state.servers.length) {
      showBlank(true);
      return;
    }
    showBlank(false);

    var route = parseHash();
    var wanted =
      (route.serverId && state.servers.some(function (s) { return s.id === route.serverId; }) && route.serverId) ||
      state.servers[0].id;
    await openServer(wanted, route.channelId);
  }

  boot();
})();
