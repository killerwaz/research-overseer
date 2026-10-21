-- "more" after a feed list (2026-10-22): the search that produced his current
-- numbered list, so "more" can fetch its next page in code. Written by WF-31 with
-- the list; every other list writer (briefs, pipeline/media sends, a re-sent PDF)
-- sets it to null — those lists are not pageable searches.
-- Left to the 9B, "more" invented articles ("Kaggle - ...") or searched the web for
-- "Research Overseer Saves".

alter table chat_results add column if not exists query jsonb;
