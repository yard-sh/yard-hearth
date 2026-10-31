# Hearth

<p align="center">
<a href="https://dash.yard.sh/projects?action=create&repo=https%3A%2F%2Fgithub.com%2Fyard-sh%2Fyard-hearth"><img src="https://yard.sh/create-in-yard.png" width="200" alt="Create in Yard" /></a>
</p>

A small Slack/Discord-style chat app built on Yard. Servers you create and join
with an invite link or ID, channels inside them, realtime messages, two roles, and editable
profiles.

## Run it

```sh
yard dev --port 9880          # landing page: http://localhost:9880/hearth/
                              # the app:      http://localhost:9880/hearth/app/
```

There is no sign-up screen and no login code in this repo. The service is
public, so anyone with the link uses Hearth as a guest, and Yard Auth signs
people in when they choose to (a consent screen the first time, silent after
that), handing the service trusted `X-Yard-*` headers. Locally, a **persona**
stands in for Yard Auth, and each persona is a different user:

| Persona          | Who they are             |
| ---------------- | ------------------------ |
| `anonymous`      | a signed-out guest       |
| `signed-in`      | a signed-in visitor      |
| `user:base`      | someone on the Base tier |
| `team`           | you, a team member       |

Switch at `http://localhost:9880/hearth/app/__yard/auth/login`, or start the server
with `yard dev --as signed-in`. A persona is a cookie, and so is the guest id,
so both are per browser profile: to be two people at once, open the app in a
normal window and a private window (two guests, or pick a different persona in
one of them).

## How it fits together

```
.yard/settings.json          one service, mounted at /app, access=public,
                             database_access=true, rooms=[Channel → CHANNELS];
                             landing_page=custom (.yard/landing-page)
.yard/migrations/0001_init.sql   users, servers, server_members (role), channels
.yard/landing-page/          the public sales page at the project root
app/_service.js              the fetch handler (REST) + export class Channel
app/index.html · styles.css · app.js · live.js    the frontend
```

**The landing page.** Everything outside `/app` is the public landing page. It
reads the Yard Auth session from `app/__yard/auth/me` (one session covers every
service of the project) and, when someone is signed in, shows their Hearth
username, email and avatar in the top-right with a menu to open the app or log
out (`__yard/auth/logout?return=/` at the project root, which comes back to the
page). "Log in" is a link to `app/__yard/auth/login?return=/`, which signs in
through Yard Auth and lands in the app; a plain link to `app/` opens it as a
guest. The avatar picture comes from `window.yard.ownership()` when Yard has
one. Try both states locally by switching persona. Custom landing pages need
Basic or Pro.

**Guests and accounts.** A signed-out visitor asks the edge for a guest id
(`POST __yard/auth/guest`), and from then on every request and socket from
that browser carries `X-Yard-Guest-Id`. Everyone is keyed by their Yard user
id, or while signed out by `guest-` and a SHA-256 hash of the guest id. The
hash matters: the guest id is the guest's credential, and member lists and
messages show every member's key to the whole server. When a guest signs in,
both headers arrive and the next request moves the guest's servers,
memberships (keeping the higher role where both were members), name and
messages to the account. The app then forgets the guest id
(`DELETE __yard/auth/guest`), so signing out later starts a fresh guest.

**Where state lives.** Structure (who exists, which servers there are, who
belongs to them with what role, which channels each server has) is in `env.DB`.
Messages and live connections are in the channel's own room storage: one
channel is one room, with its own socket set and its own rate budget. That
split is why presence and delivery need no polling.

**Roles.** `server_members.role` is `admin` or `user`, and it is the only
authority. The creator of a server is inserted as `admin`; everyone who joins
with the ID starts as `user`. Admins create and delete channels, delete anyone's
message, and promote or demote others. The owner's role is fixed so a server can
never be left without an admin. The rule is enforced in the fetch handler for
REST routes and again inside the room for message deletes, reading the role
from the attachment the handler stamped at connect time, never from the client.

**Server IDs are join codes.** Six characters from an alphabet with no `I`, `O`,
`0` or `1`, because people read them aloud and type them by hand.

**Invite links are the same code in a URL.** Server settings offers a link of
the form `…/app/?join=<server ID>`. Opening it shows who invited you to what
(`GET api/invites/<id>` returns the server's name and member count) and joins on
accept; the app then drops `?join=` from the address bar. The join box also takes
a pasted link, since `POST api/servers/join` pulls the ID out of either.

**The route is in the query.** The open server and channel are
`?server=<id>&channel=<id>`, so a sign-in round trip, which keeps the path and
query, comes back to the same channel. Older `#<server>/<channel>` links still
open.

## Ship it

```sh
yard service check                  # validate the bundle offline
yard push                           # upload into a draft release
yard releases publish v0.1.0        # go live
```

Nothing serves a draft: publishing is the deploy. To try a release before
users reach it, `yard sandbox create preview`, publish, then
`yard sandbox pin v0.1.0 --sandbox preview` and `yard service open --sandbox preview`.

Contracts: `/docs/v1/platform/services`, `/docs/v1/platform/services/rooms`,
`/docs/v1/platform/services/yard-auth`.
