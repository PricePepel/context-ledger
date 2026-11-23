# Parcels: share a graph with another machine

A graph lives in one ledger, tied to the session it cites. A parcel is a file that carries one graph to a ledger on another machine, with the transcript lines the graph cites and nothing else of the session (card R1, ADR-19 in [architecture.md](architecture.md) §17).

## Send and receive

On the machine that has the graph:

```
npm run --silent ledger -- share GRAPH_ID --out vera.parcel.json
```

`share` reads the ledger database read-only and writes a new file that only you can read. It never replaces a file. It prints how many lines the parcel carries, how many possible secrets were replaced, and whether the graph links to other graphs.

Move the file to the other machine any way you like. There:

```
npm run --silent ledger -- receive vera.parcel.json
```

`receive` checks the file and stores the graph and its lines in one transaction. If any check fails, the ledger is left as it was. Neither command needs the ledger server to be running.

The graph has the same ID on both machines. So the receiver's agent can read it over MCP, publish its own graph with links to it, and open a negotiation room with both. Sharing that second graph back gives the first machine the same room.

## What is in the file

One line of JSON, at most 8 MiB, described by [`schemas/parcel-v1.schema.json`](../schemas/parcel-v1.schema.json):

| Field | Content |
| --- | --- |
| `format`, `version` | `context-ledger-parcel`, 1 |
| `project` | The project slug of the graph's session |
| `session.id`, `session.provider` | The session's ID and `claude` or `codex` |
| `session.source` | The transcript's file name, after the secret scanner |
| `session.messages` | Only the messages on lines the graph cites: `key`, `line`, `role`, `text`, and `author` and `recipient` on an agent turn |
| `artifacts` | The commits, pull requests and files a version 3 graph cites |
| `graph.id`, `graph.packet` | The graph's ID and its packet, as published |
| `redacted` | How many possible secrets the scanner replaced |

Three things never leave: any line the graph does not cite, the session's title, and review decisions.

The text of every carried line passes through the secret scanner (`ledger redact` shows what it finds). A value it recognises becomes a `[REDACTED <kind>]` marker. The scanner knows the formats listed in its docs and can miss others, so read the lines a graph cites before you share it.

## What the receiver stores

- **A session with the sender's ID** that holds only the carried lines. Its summary says `excerpts: true`, the library labels it "excerpts", and its hand-off says the same, so nobody takes it for a whole transcript. Its title is made from the carried lines.
- **The project named in the parcel.** Links and rooms stay inside one project, and an artifact's ID includes its project slug. Two people who want a room use the same slug.
- **The graph,** published as any graph is: every citation must resolve to a carried line or artifact, and a link must point at a graph the receiver already has.

Later parcels from the same session add their lines to the same excerpts. If you later import the whole transcript file, it replaces the excerpts, keeps the keys they had, and removes the label. A file whose lines do not match the excerpts is refused.

If the receiver had already imported the same transcript, its session stays as it is, and the parcel's lines must be in it.

## Limits

- **A parcel is not signed.** `receive` trusts the file the way `import` trusts a transcript you chose. Take parcels only from people you trust. Signing with the sender's key is a later card.
- **The receiver cannot check the lines against the sender's transcript.** It checks that the graph is valid against the lines it came with.
- **Review decisions and room choices do not travel.** Each machine records its own (card R3).
- **A graph that cites only artifacts** has no line to carry and cannot be shared.
- **Someone who knows a transcript's exact bytes** can send excerpts under its ID that do not match it. The real file is then refused on import while a graph cites those excerpts.
