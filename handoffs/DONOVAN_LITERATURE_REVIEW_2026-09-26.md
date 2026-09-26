# Donovan literature & OSS review — practical, mapped to build

Maps onto the existing stack: router → analytics planner → relations engine → finance SQL → Sonnet research agent → dossiers → 746-question exam.

## 1. GraphRAG / lighter graph-RAG variants
Microsoft **GraphRAG** ([arXiv:2404.16130](https://arxiv.org/html/2404.16130v2), 2024–25) extracts an entity graph, clusters it into hierarchical communities, pre-summarizes each, and answers "global" questions from summaries. Reported: 72–83% win rate vs. plain vector RAG on comprehensiveness, 97% token reduction using root summaries. **LightRAG** ([arXiv:2410.05779](https://arxiv.org/abs/2410.05779), 2024) is the cheap variant — dual-level entity/theme retrieval, incremental updates, no expensive community pass. **HippoRAG 2** ([arXiv:2502.14802](https://arxiv.org/html/2502.14802v2), ICML 2025) fixes the known failure of KG-RAG (better multi-hop, but single-hop accuracy *drops* vs plain RAG) via Personalized PageRank over a passage-integrated graph, beating standard RAG on factual, sense-making, *and* associative tasks (+7% associative). **RAPTOR** ([arXiv:2401.18059](https://arxiv.org/abs/2401.18059), ICLR 2024) recursively summarizes chunks into a tree — +20% absolute accuracy on QuALITY.
**Mapping:** grounds the "connect the dots" workstream already flagged in `DONOVAN_MASTER_ENGINEERING_PROMPT.md` — the relations engine is a hand-built special case. Skip community-summary GraphRAG (too model-heavy for Haiku/Sonnet-only economics); adopt HippoRAG 2's PPR-over-graph as the ranking algorithm for the new KG tables (§9), RAPTOR-style summarization only for dossier narrative sections. **Effort M. Impact:** accuracy on the weakest exam category (connect-the-dots, 10/40 in round 7). **Risk:** graph drift at 100k+ docs/tenant — must update incrementally, never full-rebuild.

## 2. Anthropic Contextual Retrieval & Citations
[Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) (2024): prepend Claude-generated chunk context before embedding/BM25. Reported top-20 retrieval-failure reduction: 35% embeddings alone, 49% + contextual BM25, 67% + reranking (5.7%→1.9% baseline). The [Citations API](https://claude.com/blog/introducing-citations-api) (2025) has Claude cite exact source spans instead of asserting quotes.
**Mapping:** Donovan's chunks appear to embed without document/entity/date context — a nearly-free win. **Effort S. Impact:** recall, p95 tail, fewer false "not on file," ~$0.001–0.002/doc extra at ingest only. Citations API could replace part of the existing manual verify step (`api/_lib/agent/verify.js`), cutting a Sonnet round-trip — worth it only if it removes a whole call, otherwise redundant with what verify already does. **Risk:** low.

## 3. Hybrid BM25+dense+rerank, late interaction (ColBERT/ColPali)
Hybrid sparse+dense+rerank is already Donovan's design (Postgres FTS + pgvector + Voyage). The new piece is **ColPali** ([arXiv:2407.01449](https://arxiv.org/html/2407.01449v6), ICLR 2025): embed page *images* directly via a vision-language model instead of OCR→text→chunk. ViDoRe nDCG@5: 81.3 (ColPali) vs 65.5–66.1 (best OCR+BM25/BGE-M3), gap largest on tables/figures (65.8 vs 50.5 on tables).
**Mapping:** handwritten work orders, scanned warranty cards, faxed invoices are exactly this failure mode — today's OCR+bbox pipeline (`DEEPWELL_BUILD_SPEC.md` §3.4) is the accuracy ceiling, not the LLM. **Effort L** (new embedding model, index type, hosted inference — no hosted Claude/Voyage equivalent yet, doesn't fit serverless naturally). **Impact:** highest ceiling on low-confidence/handwritten extraction, but pilot on the worst-confidence bucket only given the infra lift.

## 4. Text-to-SQL research (BIRD, Spider 2.0) for the analytics planner
**BIRD** ([arXiv:2305.03111](https://arxiv.org/abs/2305.03111), NeurIPS 2023): best model then hit 40.1% execution accuracy vs 93.0% human across 95 real, dirty databases — the gap is external knowledge and dirty data, not SQL syntax. **Spider 2.0** ([arXiv:2411.07763](https://arxiv.org/abs/2411.07763), ICLR 2025): 632 enterprise workflows against 1000+-column warehouses; even o1-preview scores 21.3% (vs 91.2% on Spider 1.0) — failures are schema search and multi-step tool use, not one-shot NL→SQL.
**Mapping:** validates Donovan's hand-written planner over raw text-to-SQL; Spider 2.0's "agentic exploration beats single-shot" is why planner+relations+finance-SQL already outperforms naive approaches. Concretely adopt: (a) BIRD's "external knowledge" evidence strings — feed the per-tenant glossary (brand synonyms, "callback" definition) to the planner as retrieved context, not static prompt text; (b) Spider 2.0's schema-linking — embed column/entity names so the planner retrieves relevant fields instead of holding all of `field_registry` in-prompt as tenants grow. **Effort S–M. Impact:** financials/rankings categories (63/80, 10/18 in round 7), lower prompt cost at scale. **Risk:** low.

## 5. Agentic RAG / query decomposition
["Agentic RAG survey"](https://arxiv.org/abs/2501.09136) (2025) and the ["RAG-Reasoning survey"](https://aclanthology.org/2025.findings-emnlp.648.pdf) (2025) formalize what `loopV2` already does — iterative tool calls interleaved with reasoning. Consensus: explicit query decomposition before retrieval measurably improves multi-hop accuracy; escalate-only-on-need routing is the dominant cost control.
**Mapping:** Donovan has both pieces (Haiku router, Sonnet loop). Missing: explicit decomposition of conjunctive/comparison questions ("customers with X *and* callbacks within N days") before tool calls, rather than discovering the conjunction mid-loop — targets round-7's "analytics declines when a condition can't be applied" and rankings/tech-performance (0/22). **Effort S** (prompt-level decomposition step, few-shot examples). **Impact:** connect-the-dots + rankings accuracy. **Risk:** more decomposition = more tool calls; needs a complexity gate.

## 6. Grounding & hallucination evaluation
**RAGAS** ([arXiv:2309.15217](https://arxiv.org/abs/2309.15217), EACL 2024) and **ARES** ([arXiv:2311.09476](https://arxiv.org/abs/2311.09476), NAACL 2024) use fine-tuned lightweight LLM judges (ARES: accurate with only a few hundred human labels) to score context relevance, faithfulness, answer relevance without a fixed oracle. **FActScore** ([arXiv:2305.14251](https://arxiv.org/abs/2305.14251), EMNLP 2023) decomposes an answer into atomic facts, scoring each independently.
**Mapping:** the 746-question oracle exam is Donovan's own ARES-style eval, but finite and hand-written. FActScore-style atomic-claim verification is the missing piece for open-ended answers (dossiers, "explain why," narrative connect-the-dots) with no single oracle value — decompose into claims, verify each against its cited page (batchable Haiku calls), report claim-level precision instead of only pass/fail. Gives a principled per-claim fabrication metric instead of inferring it from citation coverage. **Effort M. Impact:** catches partial fabrication (right headline number, one wrong supporting detail) that today scores as a pass. **Risk:** added Haiku calls; scope to agent-generated answers only, not deterministic ones already fact-checked at source.

## 7. Entity resolution for duplicate customers/addresses
Surveys ([Science Advances 2021](https://www.science.org/doi/10.1126/sciadv.abi8021); [Sci Reports 2024](https://www.nature.com/articles/s41598-024-63242-1); [LLM entity-matching 2025](https://arxiv.org/html/2511.22832)) converge on blocking + pairwise scoring + clustering, with an LLM as final adjudicator on ambiguous pairs only (too costly as the whole pipeline).
**Mapping:** close to what `DEEPWELL_BUILD_SPEC.md` §4.5 already does (serial/address/name fuzzy scoring, `links`/`conflicts`/`duplicates`). The literature gap: a **clustering step** — today's scoring is pairwise, so transitive near-duplicate clusters (A~B, B~C, A≁C) won't merge. Add a periodic connected-components pass (union-find over `links` above threshold), reserving an LLM call only for the borderline 0.50–0.80 band already tracked as `unlinked`/`best_guess_entity`. **Effort S. Impact:** fixes a known live bug class (duplicate-customer issue noted in `START_HERE_NEXT_SESSION.md`). **Risk:** low — batch job + a merge-review UI.

## 8. KG construction from documents; property graphs in Postgres
["LLM-KG construction survey"](https://arxiv.org/pdf/2510.20345) (2025) and ["Extract, Define, Canonicalize"](https://aclanthology.org/2024.emnlp-main.548/) (EMNLP 2024) both push schema-first extraction — fix the ontology up front, extract against it, canonicalize strings to nodes — exactly Donovan's `entity_types`/`field_registry` pattern. For storage, **Apache AGE** ([age.apache.org](https://age.apache.org/overview/)) gives openCypher-on-Postgres, but recursive CTEs express bounded-depth traversal (2–4 hops) without any extension.
**Mapping:** Neon does not support arbitrary extensions the way self-hosted Postgres does — do not plan around Apache AGE on Neon. Use `entity_relations` (already in schema) + recursive CTEs, keeping RLS unmodified rather than re-deriving policies for AGE's label tables. This informs §9 directly rather than being a separate build.

## 9. Personal-knowledge-graph / Obsidian UX, graph-view libraries
Standard pattern: auto-derived bidirectional links, a backlinks panel, a force-directed graph view. **Cytoscape.js** ([js.cytoscape.org](https://js.cytoscape.org/)) is best for hundreds–low thousands of styled, interactive nodes; **sigma.js** is WebGL and scales to tens of thousands with a thinner API; **react-force-graph** is the quickest React integration but weaker past 2–3k nodes. A [2026 comparison](https://www.pkgpulse.com/guides/cytoscape-vs-vis-network-vs-sigma-graph-visualization-2026) favors Cytoscape.js on interactivity, sigma.js on scale.
**Mapping:** a single customer's subgraph (sites, units, visits, technicians, docs, invoices) is realistically dozens–low hundreds of nodes even for a 100k-doc tenant, so **Cytoscape.js** fits — the tenant-wide graph is never rendered at once, only an entity-scoped neighborhood. **Effort M** (React wrapper, layout, click-through). **Impact:** the owner's explicit second-brain ask; no Donovan-accuracy coupling. **Risk:** scope creep — ship read-only graph + backlinks first, defer authored notes since DeepWell's links derive from documents, not user input.

## 10. Latency techniques
**Semantic caching** ([GPTCache, arXiv:2411.05276](https://arxiv.org/abs/2411.05276), 2024) matches queries by embedding similarity, strongest on repeated/near-duplicate questions. **Model cascades** ([survey, arXiv:2603.04445](https://arxiv.org/html/2603.04445v2), 2026) formalize cheap-first-escalate-on-uncertainty — Donovan already does Haiku router → Sonnet agent; the refinement is escalating on a confidence score rather than fixed rules.
**Mapping:** Donovan already has an exact-text dup-cache (round-6/7 notes mention "dup cache hits"); semantic caching is the incremental step, catching paraphrases exact-match misses. **Effort S. Impact:** p50/cost on repeat-shaped questions common in small-shop usage. **Risk:** cache must invalidate per-tenant on new ingest, not just TTL.

---

## Ranked top-10 build list
1. **Contextual chunk embeddings** (Anthropic Contextual Retrieval) — S effort, broad recall lift, near-zero risk.
2. **Query decomposition** for conjunctive/comparison questions — S effort, targets the two weakest categories (connect-the-dots, tech-performance).
3. **DeepWell Knowledge Graph v1** (recursive-CTE traversal + UI, §9 design) — M/L effort, serves the owner's ask and the relations/connect-the-dots weakness together.
4. **Entity-resolution clustering pass** (connected components over `links`) — S effort, fixes a known live data-quality bug.
5. **FActScore-style atomic-claim verification** for open-ended answers — M effort, sharper fabrication metric.
6. **BIRD/Spider2.0-style schema-linking + tenant glossary retrieval** for the planner — S–M effort, helps financials/rankings, scales prompt cost.
7. **Semantic cache** layered on the existing exact-match cache — S effort, p50/cost win.
8. **Cytoscape.js graph-view UI** on #3's data — M effort, pure UX value.
9. **HippoRAG-2-style PPR ranking** over the graph tables — M effort, highest-uncertainty accuracy lever; pilot after #3.
10. **ColPali page-image embeddings** for the worst-confidence extraction bucket — L effort/new infra, highest ceiling, biggest lift; pilot-scoped, last in sequence.

## Design sketch: DeepWell Knowledge Graph (second brain)

**Reuses, doesn't replace:** `entities`, `entity_relations`, `document_entity_links`, `dossiers` already model most of this graph; the KG feature is a query/UI layer plus two new tables.

```sql
kg_edges (
  id, tenant_id, from_entity_id, to_entity_id,
  edge_type text,      -- 'installed_at','performed_by','billed_on','covers','mentions'
  weight numeric(4,3), -- confidence, reused from entity_relations/links where derived
  source text,         -- 'entity_relations' | 'document_link' | 'financial'
  source_id uuid,      -- fk back to origin row for provenance
  created_at
)
-- derived, not authored: upserted on the same writes that already populate entity_relations/links/
-- document_financials; "backlinks" = an indexed reverse query on to_entity_id, no separate table.

kg_node_cache (
  tenant_id, entity_id primary key, type_id, display_name,
  degree int, last_touched_at, summary text  -- Haiku one-liner, refreshed with dossiers
)
```
RLS: same `tenant_id = current_setting('app.tenant_id')` policy as every other table.

**Ingest:** (1) every extraction/link/financial write already happening today also upserts the matching `kg_edges` row — near-free since the facts already exist; (2) nightly job recomputes `kg_node_cache.degree` and stale summaries; (3) entity-resolution merges (§7) cascade edge rewrites via the existing `merged_into` pointer.

**Query path:** a bounded-depth `WITH RECURSIVE` walk from a seed entity over `kg_edges` (depth ≤3–4, matching customer↔site↔unit↔visit↔technician↔document↔invoice↔warranty) returns a subgraph with provenance per edge. Exposed as a new agent tool (`graph_traverse(entity_id, max_depth, edge_types?)`) alongside `follow_links`/`timeline`, callable directly by the deterministic relations engine for known-shape questions (no model call). PPR-style ranking (item 9) is a v2 addition once plain traversal ships and is measured.

**UI:** a "Graph" tab per customer/unit record — Cytoscape.js canvas seeded from the traversal query, click a node to recenter, backlinks as a reverse-edge list beside the canvas, edge click opens the source document at its cited page. Tenant-wide graph view is out of scope for v1 — always entity-scoped, keeping node counts small and RLS simple.

**Effort:** M overall (ingest hooks S, traversal + tool S, UI M). **Impact:** serves the second-brain ask while doubling as the connect-the-dots accuracy fix, since it's the same data the relations engine needs, at near-zero marginal ingest cost.
