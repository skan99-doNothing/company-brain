-- The trigram arm of search_chunks timed out on its first real query.
--
-- word_similarity(query, content) has to be computed for every row unless an
-- index can pre-filter, so it was a sequential scan over every chunk in the
-- corpus. GIN over gin_trgm_ops makes the <% operator indexable, and <% is the
-- operator form of "word_similarity is above the threshold", so the arm can
-- filter through the index and only rank what survives.

create index if not exists chunks_content_trgm_idx
  on chunks using gin (content gin_trgm_ops);
