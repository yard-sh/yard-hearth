# Hearth

<p align="center">
<a href="https://dash.yard.sh/projects?action=create&repo=https%3A%2F%2Fgithub.com%2Fyard-sh%2Fyard-hearth"><img src="https://yard.sh/create-in-yard.png" width="200" alt="Create in Yard" /></a>
</p>

A small Slack/Discord-style chat app built on Yard. Servers you create and join
with an ID, channels inside them, realtime messages, two roles, and editable
profiles.

## Run it

```sh
yard dev --port 9880          # landing page: http://localhost:9880/hearth/
                              # the app:      http://localhost:9880/hearth/app/
```

There is no sign-up screen and no login code in this repo: Yard Auth signs
people in (a consent screen the first time, silent after that) and hands the
service trusted `X-Yard-*` headers. Yard Auth is included with Basic and Pro,
and the `authenticated` service cannot be deployed without it. Locally, a
**persona** stands in for it, and each persona is a different user:

| Persona          | Who they are            |
| ---------------- | ----------------------- |
| `member`         | you, the project owner  |
| `signed-in`      | a signed-in visitor     |
| `user:base`      | someone on the Base tier|
| `trial`          | someone on a trial      |

Switch at `http://localhost:9880/hearth/app/__yard/auth/login`, or start the server
with `yard dev --as signed-in`. To be two people at once, open the app in a
normal window and a private window and pick a different persona in each.

## How it fits together

```
.yard/settings.json          one service, mounted at /app, access=authenticated,
                             database_access=true, objects=[Channel → CHANNELS];
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
out (`app/__yard/auth/logout`). "Log in" is just a link to `app/`: that service
is `authenticated`, so the edge sends anonymous visitors through Yard Auth and
back. The avatar picture comes from `window.yard.ownership()` when Yard has one.
Try both states locally by switching persona. Custom landing pages need Pro.

**Where state lives.** Structure — who exists, which servers there are, who
belongs to them with what role, which channels each server has — is in `env.DB`.
Messages and live connections are in the channel's own object storage: one
channel is one object, with its own socket set and its own rate budget. That
split is why presence and delivery need no polling.

**Roles.** `server_members.role` is `admin` or `user`, and it is the only
authority. The creator of a server is inserted as `admin`; everyone who joins
with the ID starts as `user`. Admins create and delete channels, delete anyone's
message, and promote or demote others. The owner's role is fixed so a server can
never be left without an admin. The rule is enforced in the fetch handler for
REST routes and again inside the object for message deletes, reading the role
from the attachment the handler stamped at connect time — never from the client.

**Server IDs are join codes.** Six characters from an alphabet with no `I`, `O`,
`0` or `1`, because people read them aloud and type them by hand.

## Ship it

```sh
yard service check                  # validate the bundle offline
yard push                           # upload into a draft release
yard releases publish v0.1.0        # go live
```

Nothing serves a draft — publishing is the deploy. To try a release before
buyers reach it, `yard sandbox create preview`, publish, then
`yard sandbox pin v0.1.0 --sandbox preview` and `yard service open --sandbox preview`.

Contracts: `/docs/v1/platform/services`, `/docs/v1/platform/services/objects`,
`/docs/v1/platform/services/yard-auth`.
