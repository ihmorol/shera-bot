# S25 manual-run evidence (one real run per research tool)

Recorded: 2026-11-02T12:00:00.000Z — real runtime composition, real HTTP seeding, real executor.
The SearXNG endpoint and the vision model are the local deterministic fixtures the slice records;
the real SearXNG container and a live vision provider are the NOT-VERIFIED owner items.

Tool inventory: tool_document_parse (active, READ_ONLY, recovery replayable); tool_image_understand (active, READ_ONLY, recovery needs_human); tool_note_append (active, LOCAL_MUTATION, recovery needs_human); tool_note_read (active, READ_ONLY, recovery needs_human); tool_page_fetch (active, READ_ONLY, recovery idempotent_retry); tool_spreadsheet_analyze (active, READ_ONLY, recovery replayable); tool_web_search (active, READ_ONLY, recovery needs_human)

## tool_document_parse

- capability: `research.parse.document`
- status: **succeeded**
- risk class: READ_ONLY; recovery: replayable; approval row: none (read-only auto-run)
- arguments (redacted summary): `{"path":"workspace://papers/attention.pdf"}`
- result (redacted, bounded transcript):

```
Parsed workspace://papers/attention.pdf — PDF, 1 page(s) (24 chars)
[full text (24 chars) captured as artifact artifact_68fa228e…]
Hello S25 document parse
```

## tool_web_search

- capability: `research.search`
- status: **succeeded**
- risk class: READ_ONLY; recovery: needs_human; approval row: none (read-only auto-run)
- arguments (redacted summary): `{"query":"transformer architecture literature"}`
- result (redacted, bounded transcript):

```
SearXNG search "transformer architecture literature" — 2 results
1. Attention Is All You Need
   https://arxiv.org/abs/1706.03762
   The dominant sequence transduction models are based on attention mechanisms.
   engine: arxiv
2. SearXNG documentation
   https://docs.searxng.org/
   SearXNG is a privacy-respecting metasearch engine.
   engine: duckduckgo
```

## tool_page_fetch

- capability: `research.fetch`
- status: **succeeded**
- risk class: READ_ONLY; recovery: idempotent_retry; approval row: none (read-only auto-run)
- arguments (redacted summary): `{"url":"http://127.0.0.1:37469/article"}`
- result (redacted, bounded transcript):

```
Read http://127.0.0.1:37469/article — "Attention Paper Review" (463 chars extracted)
The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose the Transformer, which dispenses with recurrence entirely and relies entirely on an attention mechanism to draw global dependencies between input and output.

The Transformer allows for significantly more parallelization and can reach a new state of the art in translation quality after being trained for as little as twelve hours on eight GPUs.
```

## tool_spreadsheet_analyze

- capability: `research.analyze.spreadsheet`
- status: **succeeded**
- risk class: READ_ONLY; recovery: replayable; approval row: none (read-only auto-run)
- arguments (redacted summary): `{"path":"workspace://data/cities.csv"}`
- result (redacted, bounded transcript):

```
Analysed workspace://data/cities.csv — sheet "Sheet1" of [Sheet1]: 4 rows × 2 columns
population: n=3 min=193324 max=545245 sum=970369 mean=323456.33
[full table (55 chars CSV) captured as artifact artifact_b4b7e7f8…]
city,population
Lisbon,545245
Porto,231800
Braga,193324
```

## tool_image_understand

- capability: `research.describe.image`
- status: **succeeded**
- risk class: READ_ONLY; recovery: needs_human; approval row: none (read-only auto-run)
- arguments (redacted summary): `{"path":"workspace://images/diagram.png"}`
- result (redacted, bounded transcript):

```
Described workspace://images/diagram.png (image/png, 70 bytes)
[full description (137 chars) captured as artifact artifact_ea2aa157…]
A small architecture diagram: input embeddings flow through stacked attention and feed-forward blocks into a linear softmax output layer.
```

## tool_page_fetch

- capability: `research.fetch`
- status: **failed** (error_code: `RESEARCH_INPUT_INVALID`)
- risk class: READ_ONLY; recovery: idempotent_retry; approval row: none (read-only auto-run)
- arguments (redacted summary): `{"url":"file:///etc/passwd"}`
- result (redacted, bounded transcript):

```
(no result)
```
