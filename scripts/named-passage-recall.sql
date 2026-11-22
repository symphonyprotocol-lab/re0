-- Recall of Discover's named-Ree ranking by binary copies (explore.ts `nearestOwnPassage`), read only.
--
--   PGOPTIONS='-c default_transaction_read_only=on' psql "$PROD_DB" -X -v ON_ERROR_STOP=1 -f scripts/named-passage-recall.sql
--
-- with PROD_DB the Neon direct (not -pooler) connection string, read into a
-- shell variable (docs/cutover/production-cutover.md §2.5).
--
-- For every public Ree the five slow test queries name (by name or tag, as
-- `namedRees` matches them), and a few questions per Ree, it compares:
--   exact  the nearest answerable passage by the stored vectors (today's answer);
--   bits   the 40 nearest by bits that differ (binary_quantize), then the
--          nearest of those by the stored vectors (the new answer).
-- Questions: up to two of the Ree's own sample questions ("own"), and the
-- first sample question of the next Ree the same query names ("other" --
-- a question about the topic, not this Ree, as a named Ree usually gets).
-- `rank` is where the exact answer falls in the bit order: 40 or less, and
-- the new answer is the same passage. The TOTAL row counts how many would
-- be with 100 or 200 candidates (EXPLORE_OWN_BIT_CANDIDATES), and the
-- worst similarity lost where they differ.
--
-- Needs no chunk_bit (it quantizes on the fly) and changes nothing. It
-- reads every vector of those Rees, some 90,000, three times per question
-- (cached after the first): a minute or a few on a cold compute.
set default_transaction_read_only = on;
set statement_timeout = '30min';
set jit = off;
\timing on

with q(question, keys) as (values
    ('medieval castle architecture', array['%medieval%', '%medievalcastle%', '%medievalcastlearchitecture%', '%castle%', '%castlearchitecture%', '%architecture%']::text[]),
    ('react server components', array['%react%', '%reactserver%', '%reactservercomponents%', '%server%', '%servercomponents%', '%components%']::text[]),
    ('python asyncio timeout', array['%python%', '%pythonasyncio%', '%pythonasynciotimeout%', '%asyncio%', '%asynciotimeout%', '%timeout%']::text[]),
    ('sleep hygiene', array['%sleep%', '%sleephygiene%', '%hygiene%']::text[]),
    ('japanese grammar particles', array['%japanese%', '%japanesegrammar%', '%japanesegrammarparticles%', '%grammar%', '%grammarparticles%', '%particles%']::text[])
  ),
  space as (select coalesce((select m.embedding_space from model_config m where m.kind = 'embedding' and m.enabled limit 1), '00000000-0000-0000-0000-000000000000'::uuid) as s),
  named as (
    select q.question, r.id, r.name, row_number() over (partition by q.question order by r.id) as n, count(*) over (partition by q.question) as of
    from q join ree r on r.is_public and r.is_published and r.moderated_at is null and r.deleted_at is null
      and regexp_replace(lower(r.name || ' ' || array_to_string(r.tags, ' ')), '[[:space:]./_-]+', '', 'g') like any (q.keys)
  ),
  asked as (
    select n.question, n.id, n.name, v.label, v.e
    from named n cross join space
    cross join lateral (
      (select 'own-' || row_number() over (order by p.id) as label, p.embedding as e from ree_profile_vector p
        where p.ree_id = n.id and p.kind = 'sample_question' and coalesce(p.embedding_space, '00000000-0000-0000-0000-000000000000'::uuid) = space.s order by p.id limit 2)
      union all
      (select 'other', p.embedding from named o join ree_profile_vector p on p.ree_id = o.id
        where o.question = n.question and o.n = n.n % n.of + 1 and o.id <> n.id and p.kind = 'sample_question'
          and coalesce(p.embedding_space, '00000000-0000-0000-0000-000000000000'::uuid) = space.s order by p.id limit 1)
    ) v
  ),
  scored as (
    select a.question, a.name, a.label, x.passages, x.exact_id, x.exact_sim, b.bit_id, b.bit_sim, x.rank
    from asked a cross join space
    cross join lateral (
      select w.passages, w.exact_id, 1 - w.exact_d as exact_sim, count(*) filter (where w.h < w.exact_h) + 1 as rank
      from (select t.h, count(*) over () as passages, first_value(t.id) over (order by t.d) as exact_id,
          first_value(t.d) over (order by t.d) as exact_d, first_value(t.h) over (order by t.d) as exact_h
        from (select c.id, s.v <=> a.e as d, binary_quantize(s.v)::bit(1536) <~> binary_quantize(a.e)::bit(1536) as h
        from chunk c join knowledge k on k.id = c.knowledge_id
        cross join lateral (select case when coalesce(c.embedding_space, '00000000-0000-0000-0000-000000000000'::uuid) = space.s then c.embedding
          when c.embedding_next_space = space.s then c.embedding_next end as v) s
        where c.ree_id = a.id
          and k.status = 'ready' and k.enabled and k.deleted_at is null and s.v is not null) t) w
      group by w.passages, w.exact_id, w.exact_d
    ) x
    cross join lateral (
      select t.id as bit_id, 1 - t.d as bit_sim from (
        select c.id, s.v <=> a.e as d
        from chunk c join knowledge k on k.id = c.knowledge_id
        cross join lateral (select case when coalesce(c.embedding_space, '00000000-0000-0000-0000-000000000000'::uuid) = space.s then c.embedding
          when c.embedding_next_space = space.s then c.embedding_next end as v) s
        where c.ree_id = a.id
          and k.status = 'ready' and k.enabled and k.deleted_at is null and s.v is not null
        order by binary_quantize(s.v)::bit(1536) <~> binary_quantize(a.e)::bit(1536)
        limit 40) t
      order by t.d limit 1
    ) b
  )
select * from (
  select 1 as o, question, name, label, passages::text, (exact_id = bit_id)::text as same,
    round(exact_sim::numeric, 4)::text as exact_sim, round(bit_sim::numeric, 4)::text as bit_sim, rank::text
  from scored
  union all
  select 2, 'TOTAL', count(*) || ' questions', '', sum(passages)::text,
    count(*) filter (where exact_id = bit_id) || ' same', 'rank<=100: ' || count(*) filter (where rank <= 100) || ', <=200: ' || count(*) filter (where rank <= 200),
    'worst gap ' || round(max(exact_sim - bit_sim)::numeric, 4), 'max rank ' || max(rank)
  from scored
) r
order by o, question, (case when same = 'false' then 0 else 1 end), name, label;
