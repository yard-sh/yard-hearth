// Hearth backend.
//
// No ports, no listen(): Yard runs this as a fetch handler. Requests arrive
// with the app path rooted at "/" and, for signed-in visitors, trusted
// identity headers the edge verified:
//   X-Yard-User-Id, X-Yard-Email, X-Yard-Entitlement, X-Yard-Tier, X-Yard-Sandbox
// Clients can never spoof these: the edge strips inbound X-Yard-* first, and
// `yard dev` stamps the same headers locally from the persona you pick. There
// is deliberately no login code anywhere in this app.
//
// Two things live in this file. The default export is the fetch handler: the
// server list, joining by ID, channels, roles, profiles, and the one route
// that hands a WebSocket to a channel. The Channel class is an object: one
// instance per channel, declared under "objects" in .yard/settings.json and
// reached through env.CHANNELS. It holds every open connection to that channel
// and that channel's messages, so it is the single place where sends and
// deletes are ordered.
//
// Structure (users, servers, membership + role, channels) is in env.DB.
// Messages are in the channel's own object storage: one channel is one object
// with its own connections and its own rate budget.

const ADMIN = "admin";
const USER = "user";

const MAX_USERNAME = 32;
const MAX_SERVER_NAME = 50;
const MAX_CHANNEL_NAME = 32;
const MAX_BODY = 2000;
const MAX_SERVERS_PER_USER = 50;
const MAX_CHANNELS_PER_SERVER = 50;
const MAX_MESSAGE_BYTES = 8 * 1024;

const KEEP_MESSAGES = 500; // per channel; older ones are pruned on insert
const SNAPSHOT_MESSAGES = 100; // how much history a joining client is sent
const FANOUT_LIMIT = 60; // channels touched by one rename / role change

const PEER_COLORS = 8;

// No I, O, 0 or 1: a server ID gets read aloud and typed by hand.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Never serve deploy inputs. Yard excludes this server-side; the guard
    // keeps any other host honest.
    if (url.pathname === "/_service.js") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname.startsWith("/api/")) {
      const started = Date.now();
      try {
        const response = await handleAPI(request, env, url);
        log("request", {
          method: request.method,
          path: url.pathname,
          status: response.status,
          user: shortId(request.headers.get("X-Yard-User-Id")),
          ms: Date.now() - started,
        });
        return response;
      } catch (err) {
        console.error(`[hearth] request.failed ${request.method} ${url.pathname}`, err && err.stack);
        return json({ error: "something went wrong on our end" }, 500);
      }
    }

    // Everything else: the static frontend (env.ASSETS is this directory).
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------- api */

async function handleAPI(request, env, url) {
  // access: "authenticated" means the edge has already turned anonymous
  // visitors away. This is the backstop, not the gate.
  const user = request.headers.get("X-Yard-User-Id");
  const method = request.method;
  if (!user) return json({ error: "sign in to use Hearth" }, 401);

  // ["api", "servers", "<id>", "channels"] -> the leading "api" is dropped.
  const [, ...seg] = url.pathname.split("/").filter(Boolean);

  /* profile */

  if (seg[0] === "me" && seg.length === 1) {
    if (method === "GET") return getMe(request, env, user);
    if (method === "PATCH") return renameMe(request, env, user);
    return methodNotAllowed();
  }

  /* servers */

  if (seg[0] === "servers" && seg.length === 1) {
    if (method === "GET") return listServers(env, user);
    if (method === "POST") return createServer(request, env, user);
    return methodNotAllowed();
  }

  // Checked before "<id>", though a 6-char uppercase code can never be "join".
  if (seg[0] === "servers" && seg[1] === "join" && seg.length === 2) {
    if (method === "POST") return joinServer(request, env, user);
    return methodNotAllowed();
  }

  if (seg[0] === "servers" && seg.length >= 2) {
    // One lookup answers both "is this person a member?" and "what may they
    // do?". Every route below reads the role from here, never from the client.
    const access = await serverAccess(env, user, seg[1]);
    if (!access) return json({ error: "server not found" }, 404);

    if (seg.length === 2) {
      if (method === "GET") return json(await serverDetail(env, user, access));
      if (method === "DELETE") return deleteServer(env, user, access);
      return methodNotAllowed();
    }

    if (seg[2] === "leave" && seg.length === 3) {
      if (method === "POST") return leaveServer(env, user, access);
      return methodNotAllowed();
    }

    if (seg[2] === "channels" && seg.length === 3) {
      if (method === "POST") return createChannel(request, env, user, access);
      return methodNotAllowed();
    }

    if (seg[2] === "channels" && seg.length === 4) {
      if (method === "DELETE") return deleteChannel(env, user, access, seg[3]);
      if (method === "PATCH") return renameChannel(request, env, user, access, seg[3]);
      return methodNotAllowed();
    }

    if (seg[2] === "members" && seg[4] === "role" && seg.length === 5) {
      if (method === "POST") return setRole(request, env, user, access, seg[3]);
      return methodNotAllowed();
    }

    return json({ error: "not found" }, 404);
  }

  /* the one realtime route */

  if (seg[0] === "channels" && seg[2] === "ws" && seg.length === 3) {
    if (method === "GET") return connectChannel(request, env, user, seg[1]);
    return methodNotAllowed();
  }

  return json({ error: "not found" }, 404);
}

/* -------------------------------------------------------------- identity */

// There is no display-name header, so the first visit derives one from the
// email and the profile screen lets people change it.
async function ensureUser(env, headers, user) {
  const email = headers.get("X-Yard-Email") || "";
  await env.DB.prepare(
    "INSERT INTO users (id, username, email, seen_at) VALUES (?1, ?2, ?3, datetime('now'))" +
      " ON CONFLICT(id) DO UPDATE SET email = excluded.email, seen_at = excluded.seen_at",
  )
    .bind(user, defaultName(user, email), email)
    .run();
  const row = await env.DB.prepare("SELECT username FROM users WHERE id = ?1").bind(user).first();
  return {
    user_id: user,
    username: row ? row.username : defaultName(user, email),
    email,
    entitlement: headers.get("X-Yard-Entitlement") || "none",
  };
}

function defaultName(user, email) {
  const local = (email.split("@")[0] || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, MAX_USERNAME);
  return local || "user-" + shortId(user);
}

async function getMe(request, env, user) {
  return json(await ensureUser(env, request.headers, user));
}

// The profile system: one editable field. The new name is pushed into every
// channel the person belongs to, so their old messages and any open
// connection show it immediately rather than after a reconnect.
async function renameMe(request, env, user) {
  const { username } = await readJSON(request);
  const clean = text(username, MAX_USERNAME);
  if (!clean) return json({ error: "pick a username" }, 400);

  const me = await ensureUser(env, request.headers, user);
  await env.DB.prepare("UPDATE users SET username = ?1 WHERE id = ?2").bind(clean, user).run();

  const { results } = await env.DB.prepare(
    "SELECT c.id FROM channels c" +
      " JOIN server_members m ON m.server_id = c.server_id AND m.user_id = ?1" +
      " LIMIT ?2",
  )
    .bind(user, FANOUT_LIMIT)
    .all();
  await Promise.all(
    (results || []).map((row) => internal(env, row.id, "/__rename", { user_id: user, name: clean })),
  );

  log("me.rename", { user: shortId(user), channels: (results || []).length });
  return json({ ...me, username: clean });
}

/* ---------------------------------------------------------------- servers */

async function listServers(env, user) {
  const { results } = await env.DB.prepare(
    "SELECT s.id, s.name, s.owner_id, m.role FROM servers s" +
      " JOIN server_members m ON m.server_id = s.id" +
      " WHERE m.user_id = ?1 ORDER BY m.joined_at",
  )
    .bind(user)
    .all();
  return json((results || []).map((row) => ({ ...row, is_owner: row.owner_id === user })));
}

// The person who creates a server is its admin. That single INSERT is the
// whole "creator is an admin" rule.
async function createServer(request, env, user) {
  const { name } = await readJSON(request);
  const clean = text(name, MAX_SERVER_NAME);
  if (!clean) return json({ error: "give your server a name" }, 400);

  const mine = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM server_members WHERE user_id = ?1",
  )
    .bind(user)
    .first();
  if (mine && mine.n >= MAX_SERVERS_PER_USER) {
    return json({ error: "you are in too many servers" }, 400);
  }

  const id = await allocateCode(env);
  if (!id) return json({ error: "could not allocate a server ID, try again" }, 503);

  await env.DB.prepare("INSERT INTO servers (id, name, owner_id) VALUES (?1, ?2, ?3)")
    .bind(id, clean, user)
    .run();
  await env.DB.prepare(
    "INSERT INTO server_members (server_id, user_id, role) VALUES (?1, ?2, ?3)",
  )
    .bind(id, user, ADMIN)
    .run();
  await env.DB.prepare("INSERT INTO channels (id, server_id, name) VALUES (?1, ?2, ?3)")
    .bind(newId(), id, "general")
    .run();

  log("server.create", { user: shortId(user), server: id });
  const access = await serverAccess(env, user, id);
  return json(await serverDetail(env, user, access), 201);
}

// The server's ID is its join code, so there is no second concept to explain.
async function allocateCode(env) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = newCode();
    const clash = await env.DB.prepare("SELECT 1 FROM servers WHERE id = ?1").bind(candidate).first();
    if (!clash) return candidate;
  }
  return null;
}

// Everyone who joins with the ID lands as a plain user. Only the creator, and
// anyone an admin promotes, is an admin.
async function joinServer(request, env, user) {
  const body = await readJSON(request);
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!CODE_RE.test(code)) return json({ error: "that is not a valid server ID" }, 400);

  const server = await env.DB.prepare("SELECT id FROM servers WHERE id = ?1").bind(code).first();
  if (!server) return json({ error: "no server with that ID" }, 404);

  const existing = await env.DB.prepare(
    "SELECT 1 FROM server_members WHERE server_id = ?1 AND user_id = ?2",
  )
    .bind(code, user)
    .first();
  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO server_members (server_id, user_id, role) VALUES (?1, ?2, ?3)",
    )
      .bind(code, user, USER)
      .run();
    log("server.join", { user: shortId(user), server: code });
  }

  const access = await serverAccess(env, user, code);
  return json({ ...(await serverDetail(env, user, access)), already_member: !!existing });
}

// Membership + role in one row. `null` means "not a member", which is also the
// answer for a server that does not exist: no probing for valid IDs.
async function serverAccess(env, user, serverId) {
  if (typeof serverId !== "string" || !ID_RE.test(serverId)) return null;
  const row = await env.DB.prepare(
    "SELECT s.id, s.name, s.owner_id, m.role FROM servers s" +
      " JOIN server_members m ON m.server_id = s.id AND m.user_id = ?2" +
      " WHERE s.id = ?1",
  )
    .bind(serverId, user)
    .first();
  if (!row) return null;
  return {
    server: { id: row.id, name: row.name, owner_id: row.owner_id },
    role: row.role === ADMIN ? ADMIN : USER,
    is_owner: row.owner_id === user,
  };
}

async function serverDetail(env, user, access) {
  const { server, role, is_owner } = access;
  const [channels, members] = await Promise.all([
    env.DB.prepare(
      "SELECT id, name FROM channels WHERE server_id = ?1 ORDER BY created_at, name",
    )
      .bind(server.id)
      .all(),
    env.DB.prepare(
      "SELECT m.user_id, m.role, COALESCE(u.username, 'someone') AS username FROM server_members m" +
        " LEFT JOIN users u ON u.id = m.user_id" +
        " WHERE m.server_id = ?1 ORDER BY m.role, username",
    )
      .bind(server.id)
      .all(),
  ]);
  return {
    id: server.id,
    name: server.name,
    owner_id: server.owner_id,
    role,
    is_owner,
    channels: channels.results || [],
    members: (members.results || []).map((m) => ({ ...m, is_owner: m.user_id === server.owner_id })),
  };
}

async function leaveServer(env, user, access) {
  if (access.is_owner) {
    return json({ error: "you own this server, delete it instead", code: "owner" }, 400);
  }
  await env.DB.prepare("DELETE FROM server_members WHERE server_id = ?1 AND user_id = ?2")
    .bind(access.server.id, user)
    .run();
  log("server.leave", { user: shortId(user), server: access.server.id });
  return json({ ok: true });
}

async function deleteServer(env, user, access) {
  if (!access.is_owner) {
    return json({ error: "only the server's owner can delete it", code: "owner_only" }, 403);
  }
  const { results } = await env.DB.prepare("SELECT id FROM channels WHERE server_id = ?1")
    .bind(access.server.id)
    .all();
  await Promise.all((results || []).map((row) => internal(env, row.id, "/__destroy")));
  await env.DB.prepare("DELETE FROM channels WHERE server_id = ?1").bind(access.server.id).run();
  await env.DB.prepare("DELETE FROM server_members WHERE server_id = ?1").bind(access.server.id).run();
  await env.DB.prepare("DELETE FROM servers WHERE id = ?1").bind(access.server.id).run();
  log("server.delete", { server: access.server.id, channels: (results || []).length });
  return json({ ok: true });
}

/* --------------------------------------------------------------- channels */

async function createChannel(request, env, user, access) {
  if (access.role !== ADMIN) return adminOnly("create channels");
  const { name } = await readJSON(request);
  const clean = channelName(name);
  if (!clean) return json({ error: "give the channel a name" }, 400);

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM channels WHERE server_id = ?1")
    .bind(access.server.id)
    .first();
  if (count && count.n >= MAX_CHANNELS_PER_SERVER) {
    return json({ error: "this server has too many channels" }, 400);
  }

  const id = newId();
  await env.DB.prepare("INSERT INTO channels (id, server_id, name) VALUES (?1, ?2, ?3)")
    .bind(id, access.server.id, clean)
    .run();
  log("channel.create", { user: shortId(user), server: access.server.id, channel: shortId(id) });
  return json({ id, name: clean }, 201);
}

async function deleteChannel(env, user, access, channelId) {
  if (access.role !== ADMIN) return adminOnly("delete channels");
  const channel = await channelIn(env, access.server.id, channelId);
  if (!channel) return json({ error: "channel not found" }, 404);

  await env.DB.prepare("DELETE FROM channels WHERE id = ?1").bind(channel.id).run();
  // The messages live in the object, so removing the row is only half of it.
  await internal(env, channel.id, "/__destroy");
  log("channel.delete", { user: shortId(user), channel: shortId(channel.id) });
  return json({ ok: true });
}

async function renameChannel(request, env, user, access, channelId) {
  if (access.role !== ADMIN) return adminOnly("rename channels");
  const channel = await channelIn(env, access.server.id, channelId);
  if (!channel) return json({ error: "channel not found" }, 404);
  const { name } = await readJSON(request);
  const clean = channelName(name);
  if (!clean) return json({ error: "give the channel a name" }, 400);

  await env.DB.prepare("UPDATE channels SET name = ?1 WHERE id = ?2").bind(clean, channel.id).run();
  await internal(env, channel.id, "/__meta", { name: clean });
  return json({ id: channel.id, name: clean });
}

async function channelIn(env, serverId, channelId) {
  if (typeof channelId !== "string" || !ID_RE.test(channelId)) return null;
  return env.DB.prepare("SELECT id, name FROM channels WHERE id = ?1 AND server_id = ?2")
    .bind(channelId, serverId)
    .first();
}

/* ------------------------------------------------------------------ roles */

// Two roles, and this is the only way to move between them. The owner's role
// is fixed so a server can never be left without an admin.
async function setRole(request, env, user, access, targetId) {
  if (access.role !== ADMIN) return adminOnly("change roles");
  const { role } = await readJSON(request);
  const next = role === ADMIN ? ADMIN : USER;

  if (targetId === access.server.owner_id) {
    return json({ error: "the server owner is always an admin", code: "owner" }, 400);
  }
  const member = await env.DB.prepare(
    "SELECT 1 FROM server_members WHERE server_id = ?1 AND user_id = ?2",
  )
    .bind(access.server.id, targetId)
    .first();
  if (!member) return json({ error: "not a member of this server" }, 404);

  await env.DB.prepare(
    "UPDATE server_members SET role = ?1 WHERE server_id = ?2 AND user_id = ?3",
  )
    .bind(next, access.server.id, targetId)
    .run();

  // Someone may be connected right now with the old role on their attachment.
  const { results } = await env.DB.prepare(
    "SELECT id FROM channels WHERE server_id = ?1 LIMIT ?2",
  )
    .bind(access.server.id, FANOUT_LIMIT)
    .all();
  await Promise.all(
    (results || []).map((row) => internal(env, row.id, "/__role", { user_id: targetId, role: next })),
  );

  log("role.set", { by: shortId(user), target: shortId(targetId), role: next });
  return json({ user_id: targetId, role: next });
}

/* --------------------------------------------------------------- realtime */

// The only route that reaches an object. Membership and role are resolved
// here, against the database, and travel to the object as headers it can
// trust: nothing else can reach the object, exactly as nothing but the edge
// can set X-Yard-*.
async function connectChannel(request, env, user, channelId) {
  if (typeof channelId !== "string" || !ID_RE.test(channelId)) {
    return json({ error: "channel not found" }, 404);
  }
  const row = await env.DB.prepare(
    "SELECT c.id, c.name, s.name AS server_name, m.role FROM channels c" +
      " JOIN servers s ON s.id = c.server_id" +
      " JOIN server_members m ON m.server_id = c.server_id AND m.user_id = ?2" +
      " WHERE c.id = ?1",
  )
    .bind(channelId, user)
    .first();
  if (!row) return json({ error: "channel not found" }, 404);

  if (request.headers.get("Upgrade") !== "websocket") {
    return json({ error: "expected a WebSocket" }, 426);
  }

  const me = await env.DB.prepare("SELECT username FROM users WHERE id = ?1").bind(user).first();
  const username = me
    ? me.username
    : defaultName(user, request.headers.get("X-Yard-Email") || "");

  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase().startsWith("x-hearth-")) headers.delete(key);
  }
  headers.set("X-Hearth-Channel", row.id);
  headers.set("X-Hearth-Channel-Name", encodeURIComponent(row.name));
  headers.set("X-Hearth-Server-Name", encodeURIComponent(row.server_name));
  headers.set("X-Hearth-Role", row.role === ADMIN ? ADMIN : USER);
  headers.set("X-Hearth-Name", encodeURIComponent(username));

  log("ws.forward", { user: shortId(user), channel: shortId(row.id), role: row.role });
  return objectFor(env, row.id).fetch(new Request(request, { headers }));
}

function objectFor(env, channelId) {
  return env.CHANNELS.get(env.CHANNELS.idFromName(channelId));
}

// Handler-to-object calls that are not upgrades. Clients cannot reach the
// object directly, so paths under /__ are private by construction.
async function internal(env, channelId, path, body) {
  try {
    return await objectFor(env, channelId).fetch("https://hearth.internal" + path, {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[hearth] internal.failed path=${path} channel=${shortId(channelId)}`, err && err.stack);
    return new Response(null, { status: 502 });
  }
}

function adminOnly(what) {
  return json({ error: `only an admin can ${what}`, code: "admin_only" }, 403);
}

/* --------------------------------------------------------------- Channel */

// One instance per channel. The runtime creates it when the first request for
// that channel arrives and may retire it when the channel goes quiet, so
// instance fields are a cache at best: everything that matters is in
// ctx.storage (messages, meta) or attached to a connection.
export class Channel {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.meta = null;
    this.ctx.blockConcurrencyWhile(async () => {
      this.createTables();
      this.meta = (await this.ctx.storage.get("meta")) || freshMeta();
    });
  }

  createTables() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (" +
        " id TEXT PRIMARY KEY, author_id TEXT NOT NULL, author_name TEXT NOT NULL," +
        " body TEXT NOT NULL, at INTEGER NOT NULL, seq INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages (seq)");
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") return this.join(request);

    const url = new URL(request.url);
    if (request.method === "POST") {
      if (url.pathname === "/__destroy") return this.destroy();
      if (url.pathname === "/__meta") return this.updateMeta(request);
      if (url.pathname === "/__rename") return this.renameAuthor(request);
      if (url.pathname === "/__role") return this.applyRole(request);
    }
    return new Response("Not found", { status: 404 });
  }

  /* connections */

  async join(request) {
    const userId = request.headers.get("X-Yard-User-Id") || "";
    if (!userId) return new Response("sign in", { status: 401 });
    const h = request.headers;

    // The handler just read these rows, so this is the freshest copy.
    this.meta.channel = h.get("X-Hearth-Channel") || this.meta.channel;
    this.meta.name = decodeURIComponent(h.get("X-Hearth-Channel-Name") || "") || this.meta.name;
    this.meta.server = decodeURIComponent(h.get("X-Hearth-Server-Name") || "") || this.meta.server;

    const role = h.get("X-Hearth-Role") === ADMIN ? ADMIN : USER;
    const name = text(decodeURIComponent(h.get("X-Hearth-Name") || ""), MAX_USERNAME) || "someone";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const peer = {
      cid: crypto.randomUUID().slice(0, 8),
      user_id: userId,
      name,
      role,
      color: this.meta.nextColor % PEER_COLORS,
    };
    this.meta.nextColor = (this.meta.nextColor + 1) % PEER_COLORS;
    await this.saveMeta();

    // The attachment is the only thing a message can be traced back to: a
    // WebSocket frame carries no headers. The tag lets a rename or a role
    // change find every connection this person has open on this channel.
    server.serializeAttachment(peer);
    this.ctx.acceptWebSocket(server, [userId]);

    send(server, {
      t: "snapshot",
      channel: { id: this.meta.channel, name: this.meta.name, server: this.meta.server },
      you: peer,
      peers: this.peers(peer.cid),
      messages: this.recent(),
    });
    this.broadcast({ t: "join", peer }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string") return;
    if (raw.length > MAX_MESSAGE_BYTES) {
      return send(ws, { t: "error", code: "too_big", message: "that message is too large" });
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = attachment(ws);
    if (!me) return;

    if (msg.t === "send") return this.postMessage(ws, me, msg.body);
    if (msg.t === "delete") return this.deleteMessage(ws, me, msg.id);
    if (msg.t === "typing") return this.broadcast({ t: "typing", cid: me.cid, name: me.name }, ws);
  }

  async webSocketClose(ws) {
    const me = attachment(ws);
    if (me) this.broadcast({ t: "leave", cid: me.cid }, ws);
  }

  async webSocketError(ws) {
    const me = attachment(ws);
    if (me) this.broadcast({ t: "leave", cid: me.cid }, ws);
  }

  /* messages */

  async postMessage(ws, me, body) {
    const clean = text(body, MAX_BODY);
    if (!clean) return;

    this.meta.seq += 1;
    const message = {
      id: newId(),
      author_id: me.user_id,
      author_name: me.name,
      body: clean,
      at: Date.now(),
      seq: this.meta.seq,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, author_id, author_name, body, at, seq) VALUES (?, ?, ?, ?, ?, ?)",
      message.id,
      message.author_id,
      message.author_name,
      message.body,
      message.at,
      message.seq,
    );
    this.prune();
    await this.saveMeta();
    // Including the sender: everyone renders the same canonical row.
    this.broadcast({ t: "message", message });
  }

  // The roles system, enforced where the data is. An admin may delete anyone's
  // message; everyone else only their own. The role is read from the
  // attachment the handler stamped at connect time, never from the frame.
  async deleteMessage(ws, me, id) {
    if (typeof id !== "string" || !ID_RE.test(id)) return;
    const row = this.ctx.storage.sql
      .exec("SELECT author_id FROM messages WHERE id = ?", id)
      .toArray()[0];
    if (!row) return;

    if (me.role !== ADMIN && row.author_id !== me.user_id) {
      return send(ws, {
        t: "error",
        code: "forbidden",
        message: "only an admin can delete someone else's message",
      });
    }
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", id);
    this.broadcast({ t: "delete", id, by: me.name });
  }

  /* handler-only routes */

  async updateMeta(request) {
    const body = await readJSON(request);
    const clean = channelName(body.name);
    if (clean) {
      this.meta.name = clean;
      await this.saveMeta();
      this.broadcast({ t: "channel", name: clean });
    }
    return json({ ok: true });
  }

  async renameAuthor(request) {
    const body = await readJSON(request);
    const clean = text(body.name, MAX_USERNAME);
    if (!body.user_id || !clean) return json({ ok: false }, 400);

    this.ctx.storage.sql.exec(
      "UPDATE messages SET author_name = ? WHERE author_id = ?",
      clean,
      body.user_id,
    );
    for (const socket of this.ctx.getWebSockets(body.user_id)) {
      const peer = attachment(socket);
      if (peer) socket.serializeAttachment({ ...peer, name: clean });
    }
    this.broadcast({ t: "rename", user_id: body.user_id, name: clean });
    return json({ ok: true });
  }

  async applyRole(request) {
    const body = await readJSON(request);
    const next = body.role === ADMIN ? ADMIN : USER;
    if (!body.user_id) return json({ ok: false }, 400);

    for (const socket of this.ctx.getWebSockets(body.user_id)) {
      const peer = attachment(socket);
      if (peer) socket.serializeAttachment({ ...peer, role: next });
    }
    this.broadcast({ t: "role", user_id: body.user_id, role: next });
    return json({ ok: true });
  }

  async destroy() {
    const sockets = this.ctx.getWebSockets();
    this.broadcast({ t: "gone" });
    for (const socket of sockets) {
      try {
        socket.close(4004, "Channel deleted");
      } catch {
        // Already gone.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.createTables();
    this.meta = freshMeta();
    log("channel.destroyed", { closed: sockets.length });
    return json({ ok: true });
  }

  /* storage */

  recent() {
    return this.ctx.storage.sql
      .exec(
        "SELECT id, author_id, author_name, body, at, seq FROM messages ORDER BY seq DESC LIMIT ?",
        SNAPSHOT_MESSAGES,
      )
      .toArray()
      .reverse();
  }

  count() {
    return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n;
  }

  prune() {
    const n = this.count();
    if (n <= KEEP_MESSAGES) return;
    this.ctx.storage.sql.exec(
      "DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY seq ASC LIMIT ?)",
      n - KEEP_MESSAGES,
    );
  }

  saveMeta() {
    return this.ctx.storage.put("meta", this.meta);
  }

  peers(exceptCid) {
    const out = [];
    for (const socket of this.ctx.getWebSockets()) {
      const peer = attachment(socket);
      if (!peer || peer.cid === exceptCid) continue;
      out.push({ cid: peer.cid, user_id: peer.user_id, name: peer.name, role: peer.role, color: peer.color });
    }
    return out;
  }

  broadcast(event, except) {
    const data = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(data);
      } catch {
        // A socket mid-close is dropped by the runtime; nothing to do here.
      }
    }
  }
}

function freshMeta() {
  return { channel: "", name: "", server: "", seq: 0, nextColor: 0 };
}

function attachment(ws) {
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

function send(ws, event) {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // Closed between the check and the send.
  }
}

/* ------------------------------------------------------------ validation */

function text(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

// Channel names look like Discord's: lowercase, hyphenated, no spaces.
function channelName(value) {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_CHANNEL_NAME);
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/* ----------------------------------------------------------------- utils */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function readJSON(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function methodNotAllowed() {
  return json({ error: "method not allowed" }, 405);
}

function shortId(value) {
  return typeof value === "string" && value ? value.slice(0, 8) : "-";
}

function log(event, fields) {
  const parts = Object.entries(fields || {}).map(([k, v]) => `${k}=${v}`);
  console.log(`[hearth] ${event} ${parts.join(" ")}`);
}
