# Parcels: share a graph with another machine

A graph lives in one ledger, tied to the session it cites. A parcel is a file that carries one graph to a ledger on another machine, with the transcript lines the graph cites and nothing else of the session (card R1, ADR-19 in [architecture.md](architecture.md) §17).

## Send and receive

On the machine that has the graph:

```
npm run --silent ledger -- share GRAPH_ID --out vera.parcel.json
```

`share` reads the ledger database read-only and writes a new file. It never replaces a file. On Linux and macOS only you can read the file (mode 0600). On Windows it gets the permissions of its folder, so write it to a folder only you can read. It prints how many lines the parcel carries, how many possible secrets were replaced, and whether the graph links to other graphs.

Move the file to the other machine any way you like. There:

```
npm run --silent ledger -- receive vera.parcel.json
```

`receive` checks the file and stores the graph and its lines in one transaction. If any check fails, nothing of the parcel is stored. A file that is wrong in itself (not a parcel, not a valid graph apart from the graphs it links to, a graph ID that does not match, lines that are not exactly the cited ones) is refused before the database is opened. Other checks need the ledger, and opening it creates the database or upgrades its schema first, as `import` does. Neither command needs the ledger server to be running.

The graph has the same ID on both machines. So the receiver's agent can read it over MCP, publish its own graph with links to it, and open a negotiation room with both. Sharing that second graph back gives the first machine the same room.

## What is in the file

One line of JSON, at most 8 MiB, described by [`schemas/parcel-v1.schema.json`](../schemas/parcel-v1.schema.json):

| Field | Content |
| --- | --- |
| `format`, `version` | `context-ledger-parcel`, 1 |
| `project` | The project slug of the graph's session |
| `session.id`, `session.provider` | The session's ID and `claude` or `codex` |
| `session.source` | The transcript's file name, after the secret scanner. If a marker makes it longer than a ledger stores, it is `source name redacted` |
| `session.messages` | Only the messages on lines the graph cites: `key`, `line`, `role`, `text`, and `author` and `recipient` on an agent turn |
| `artifacts` | The commits, pull requests and files a version 3 graph cites |
| `graph.id`, `graph.packet` | The graph's ID and its packet, as published |
| `redacted` | How many possible secrets the scanner replaced, in the file name and in the text, authors and recipients of the carried lines |

`share` copies no line the graph does not cite, and not the session's title or any review decision. A parcel carries exactly the lines and artifacts its graph cites: `receive` refuses a file with one more or one fewer.

The text of every carried line passes through the secret scanner (`ledger redact` shows what it finds). A value it recognises becomes a `[REDACTED <kind>]` marker. The scanner can miss a credential in a format it does not know, so read the lines a graph cites before you share it.

**The graph's own text travels as it was published.** Labels, node and party names, artifact paths and the project slug cannot be changed, because the graph's ID and the artifact IDs cover them. So `share` refuses a graph when:

- one of those holds what the scanner takes for a credential, or
- a label repeats a turn the graph does not cite, or one line of such a turn (a line ends at any line-break character). The guard looks for the first 120 characters with white space squeezed (which is also how a session's title is made), when that is 20 characters or more, and ignores case. Words that a carried line also holds are not counted.

A label can still say in other words what an uncited line says, or quote a part from the middle of a line. Read the labels before you share a graph.

The file is plain JSON. Control and invisible formatting characters in it are written as `\u` escapes, so an editor or a terminal shows what the file holds.

## What the receiver stores

- **A session with the sender's ID** that holds only the carried lines. Its summary says `excerpts: true`, the library labels it "excerpts", and its hand-off says the same, so nobody takes it for a whole transcript. Its title is made from the carried lines.
- **The project named in the parcel.** Links and rooms stay inside one project, and an artifact's ID includes its project slug. Two people who want a room use the same slug.
- **The graph,** published as any graph is: every citation must resolve to a carried line or artifact, and a link must point at a graph the receiver already has.

Later parcels from the same session add their lines to the same excerpts. If you later import the whole transcript file, it replaces the excerpts and removes the label. An excerpt keeps its key only when a graph stored here cites that key (a version 3 graph); every other line takes the file's own key. Lines that came with a version 1 or 2 graph, which cites lines, are stored under the placeholder key `l:<line>`, because nothing checks the keys such a parcel carries; a later version 3 parcel or the transcript gives them their real keys. A file that gives such a cited key to another line is refused, with that reason, and nothing changes.

A line that two sources both have must be the same turn: the same key, line number and role, and the same text. Text counts as the same when one is the other with values replaced by `[REDACTED <kind>]` markers, each marker standing for at least one character. So a redacted excerpt matches its transcript whichever build redacted it, and text changed in any other way is a conflict: the parcel or the file is refused and nothing changes. Two parcels that redact the same line in different places are a conflict too, because neither is a redaction of the other; importing the transcript itself, or a parcel from one build, resolves it.

If the receiver had already imported the same transcript, its session stays as it is, and the parcel's lines must be in it.

The savings meter of `context_for` compares a graph with its session's hand-off. For an excerpt session that hand-off is only the carried lines, and the meter says so with `baseline: "excerpts"`.

## Limits

- **A parcel is not signed.** `receive` trusts the file the way `import` trusts a transcript you chose. Take parcels only from people you trust. Signing with the sender's key is a later card.
- **The receiver cannot check the lines against the sender's transcript.** It checks that the graph is valid against the lines it came with.
- **Review decisions and room choices do not travel.** Each machine records its own (card R3).
- **A graph that cites only artifacts** has no line to carry and cannot be shared.
- **Someone who knows a transcript's exact bytes** can send excerpts under its ID that do not match it. The real file is then refused on import while a graph cites those excerpts.
- **A parcel is at most 8 MiB.** `share` refuses a graph that cites more text than that.
